import { Kysely, PostgresDialect, sql } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import * as blocks from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const ADMIN = 3;
const TEACHER = 4;

interface StaffData {
  id: string;
  version: number;
  person: { id: string; email: string };
}

interface AdminData {
  institutionId: string;
  staffMemberId: string;
  person: { id: string; displayName: string };
  grantedAt: string;
}

/** INS-08 to INS-10 (API design 10.5), and how STF-05, STF-10 and STF-13 treat the access they tie to a record. */
describe('Institution Admins: promoted from the staff', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const staffUsers: string[] = [];

  let owner: SignedInPerson;
  let societyA: string;
  let first: string;
  let second: string;
  let categoryId: string;

  const makeSociety = async () => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    societies.push(res.body.data.id);
    return res.body.data.id as string;
  };

  const makeInstitution = async (token: string) => {
    const res = await api('post', '/v1/institutions', token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };

  const added = async (fields: object = {}, token = owner.token) => {
    const res = await api('post', '/v1/staff', token, {
      homeInstitutionId: first,
      email: `${newId()}@staff.test`,
      firstName: 'Meera',
      classCategoryId: categoryId,
      mobile: { countryCode: '91', number: '9876500001' },
      ...fields,
    });
    expect(res.status).toBe(201);
    const staff = res.body.data as unknown as StaffData;
    if (!('email' in fields)) staffUsers.push(staff.person.id);
    return staff;
  };

  const grant = (institutionId: string, staffMemberId: unknown, token = owner.token) =>
    api('post', `/v1/institutions/${institutionId}/admins`, token, { staffMemberId });
  const revoke = (institutionId: string, staffMemberId: string, token = owner.token) =>
    api('delete', `/v1/institutions/${institutionId}/admins/${staffMemberId}`, token);
  const admins = (institutionId: string, query = '', token = owner.token) =>
    api('get', `/v1/institutions/${institutionId}/admins${query}`, token);

  /** Signs the person in and chooses the context; returns the token that acts in it. */
  const actingAs = async (address: string, roleCode: number, societyId = societyA) => {
    const login = await signInMobile(t, address);
    const chosen = await api('post', '/v1/auth/context', login.accessToken, {
      roleCode,
      societyId,
    });
    expect(chosen.status).toBe(200);
    return { token: chosen.body.data.accessToken as string, login };
  };

  const audit = (id: string) =>
    readAuditRows<{
      action: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${id}`);

  const reads = (token: string, institution: string) =>
    api('get', `/v1/fixtures/tenant/institutions/${institution}`, token);

  const grantRows = (staffMemberId: string) =>
    sql<{ institution_id: string; revoked_at: Date | null; revoke_reason: string | null }>`
      select institution_id, revoked_at, revoke_reason from role_assignments
      where staff_member_id = ${staffMemberId} and role_code = 3 order by institution_id`
      .execute(ownerDb)
      .then((result) => result.rows);

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
    fixtures = new PlatformFixtures(t, ownerDb);
    api = apiCaller(t);
    const { rows } = await sql<{ id: string }>`
      select id from class_categories where status = 1 order by display_order limit 1
    `.execute(ownerDb);
    categoryId = rows[0]!.id;
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    societyA = await makeSociety();
    owner = await fixtures.owner(societyA);
    first = await makeInstitution(owner.token);
    second = await makeInstitution(owner.token);
  });

  afterEach(async () => {
    await blocks.clearBlocks(ownerDb);
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    for (const id of staffUsers.splice(0)) {
      await sql`delete from users where id = ${id}`.execute(ownerDb);
    }
    await fixtures.cleanup();
  });

  describe('INS-09 grant', () => {
    it('promotes a staff member of the Institution: the person gets the Admin context, and is told after the commit', async () => {
      const staff = await added();
      const res = await grant(first, staff.id);
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        institutionId: first,
        staffMemberId: staff.id,
        person: { id: staff.person.id, displayName: 'Meera' },
        grantedAt: expect.any(String),
      });

      // Teacher / Staff stays, and the Admin context is new; the Admin reaches the Institution as an Admin.
      const login = await signInMobile(t, staff.person.email);
      expect(login.contexts.map((c) => c.roleCode).toSorted()).toEqual([ADMIN, TEACHER]);
      const { token } = await actingAs(staff.person.email, ADMIN);
      expect((await reads(token, first)).status).toBe(200);
      expect((await reads(token, second)).status).toBe(404);

      expect(t.email.latest(staff.person.email, 'admin-access-granted')?.variables).toMatchObject({
        institution: 'Green Valley School',
      });
      const entry = (await audit(staff.id)).find((row) => row.action === 'access.grant');
      expect(entry?.new_values).toMatchObject({ roleCode: 3, personId: staff.person.id });
    });

    it('accepts a staff member whose extra Institution this is, and refuses one who works elsewhere', async () => {
      const staff = await added();
      expect((await grant(second, staff.id)).status).toBe(422);
      expect((await grant(second, staff.id)).body.code).toBe('STAFF_NOT_AT_INSTITUTION');
      expect(
        (
          await api('put', `/v1/staff/${staff.id}/institutions`, owner.token, {
            institutionIds: [second],
          })
        ).status,
      ).toBe(200);
      expect((await grant(second, staff.id)).status).toBe(201);
    });

    it('is 404 for a record that is not in the Society or is deactivated, and 422 for one that is blocked', async () => {
      const staff = await added();
      const other = await makeSociety();
      const ownerB = await fixtures.owner(other);
      const institutionB = await makeInstitution(ownerB.token);
      const inB = await added({ homeInstitutionId: institutionB }, ownerB.token);
      expect((await grant(first, inB.id)).status).toBe(404);
      expect((await grant(first, newId())).status).toBe(404);

      expect((await api('post', `/v1/staff/${staff.id}/block`, owner.token)).status).toBe(200);
      const blocked = await grant(first, staff.id);
      expect(blocked.status).toBe(422);
      expect(blocked.body.code).toBe('STAFF_BLOCKED');
      await api('post', `/v1/staff/${staff.id}/unblock`, owner.token);

      expect((await api('delete', `/v1/staff/${staff.id}`, owner.token)).status).toBe(200);
      expect((await grant(first, staff.id)).status).toBe(404);
    });

    it('is 409 ALREADY_ADMIN for the second grant, and 409 ACCOUNT_BLOCKED for a person whose account is blocked', async () => {
      const staff = await added();
      expect((await grant(first, staff.id)).status).toBe(201);
      const again = await grant(first, staff.id);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_ADMIN');

      const other = await added();
      await sql`update users set account_status = 2, blocked_at = now() where id = ${other.person.id}`.execute(
        ownerDb,
      );
      const refused = await grant(first, other.id);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('ACCOUNT_BLOCKED');
      expect(await grantRows(other.id)).toEqual([]);
    });

    it('checks the body: a missing or malformed staffMemberId is 400, and no other field is allowed', async () => {
      expect((await grant(first, undefined)).status).toBe(400);
      expect((await grant(first, 'not-a-uuid')).status).toBe(400);
      const staff = await added();
      const extra = await api('post', `/v1/institutions/${first}/admins`, owner.token, {
        staffMemberId: staff.id,
        roleCode: 2,
      });
      expect(extra.status).toBe(400);
    });

    it('is for the Owner of the Society only: an Institution Admin, a teacher, the Super Admin and another Society’s Owner get nothing', async () => {
      const staff = await added();
      const institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
      expect((await grant(first, staff.id, institutionAdmin.token)).status).toBe(403);
      const { token: teacher } = await actingAs(staff.person.email, TEACHER);
      expect((await grant(first, staff.id, teacher)).status).toBe(403);
      expect((await grant(first, staff.id, admin)).status).toBe(403);
      const other = await makeSociety();
      const ownerB = await fixtures.owner(other);
      expect((await grant(first, staff.id, ownerB.token)).status).toBe(404);
      expect(await grantRows(staff.id)).toEqual([]);
    });
  });

  describe('INS-08 list', () => {
    it('lists the Admins of the Institution by name, a page at a time, and no one else’s', async () => {
      const [a, b, c] = [
        await added({ firstName: 'Asha' }),
        await added({ firstName: 'Zara' }),
        await added(),
      ];
      await grant(first, b.id);
      await grant(first, a.id);
      await grant(second, c.id).then((res) => expect(res.status).toBe(422));
      const res = await admins(first);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, totalItems: 2, totalPages: 1 });
      expect((res.body.data as unknown as AdminData[]).map((row) => row.staffMemberId)).toEqual([
        a.id,
        b.id,
      ]);
      expect(res.body.data[0]).toMatchObject({ institutionId: first, person: { id: a.person.id } });

      const page = await admins(first, '?limit=1&page=2');
      expect((page.body.data as unknown as AdminData[]).map((row) => row.staffMemberId)).toEqual([
        b.id,
      ]);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 1, totalItems: 2, totalPages: 2 });
      expect((await admins(second)).body.data).toEqual([]);
    });

    it('refuses a search or a sort, which the list does not have, and is for the Owner of the Society', async () => {
      expect((await admins(first, '?q=asha')).status).toBe(400);
      expect((await admins(first, '?sort=name')).status).toBe(400);
      const institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
      expect((await admins(first, '', institutionAdmin.token)).status).toBe(403);
      const other = await makeSociety();
      const ownerB = await fixtures.owner(other);
      expect((await admins(first, '', ownerB.token)).status).toBe(404);
      expect((await admins(newId())).status).toBe(404);
    });
  });

  describe('INS-10 revoke', () => {
    it('takes the access away: the open Admin session ends, the list drops them, and they are told', async () => {
      const staff = await added();
      await grant(first, staff.id);
      const { token: asAdmin } = await actingAs(staff.person.email, ADMIN);
      const { token: asTeacher } = await actingAs(staff.person.email, TEACHER);
      expect((await reads(asAdmin, first)).status).toBe(200);

      const res = await revoke(first, staff.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();

      const ended = await reads(asAdmin, first);
      expect(ended.status).toBe(401);
      expect(ended.body).toMatchObject({
        code: 'SESSION_ENDED',
        data: { reason: 'admin_revoked' },
      });
      // The teacher session of the same person goes on.
      expect((await api('get', '/v1/me', asTeacher)).status).toBe(200);
      expect((await admins(first)).body.data).toEqual([]);
      expect((await signInMobile(t, staff.person.email)).contexts.map((c) => c.roleCode)).toEqual([
        TEACHER,
      ]);
      expect(t.email.latest(staff.person.email, 'admin-access-revoked')).toBeDefined();

      const entry = (await audit(staff.id)).find((row) => row.action === 'access.revoke');
      expect(entry).toMatchObject({
        old_values: { roleCode: 3, personId: staff.person.id },
        new_values: { sessionsEnded: 1 },
      });
      expect(await grantRows(staff.id)).toEqual([
        { institution_id: first, revoked_at: expect.any(Date), revoke_reason: 'revoked_by_owner' },
      ]);
    });

    it('revokes one Institution and leaves the other, and the person can be promoted again', async () => {
      const staff = await added();
      await api('put', `/v1/staff/${staff.id}/institutions`, owner.token, {
        institutionIds: [second],
      });
      await grant(first, staff.id);
      await grant(second, staff.id);
      expect((await revoke(second, staff.id)).status).toBe(200);
      expect(
        ((await admins(first)).body.data as unknown as AdminData[]).map((row) => row.staffMemberId),
      ).toEqual([staff.id]);
      expect((await admins(second)).body.data).toEqual([]);
      const { token } = await actingAs(staff.person.email, ADMIN);
      expect((await reads(token, first)).status).toBe(200);
      expect((await reads(token, second)).status).toBe(404);
      expect((await grant(second, staff.id)).status).toBe(201);
    });

    it('is 404 for a record without the grant, a record of another Society and an unknown one, and for anyone but the Owner', async () => {
      const staff = await added();
      expect((await revoke(first, staff.id)).status).toBe(404);
      expect((await revoke(first, newId())).status).toBe(404);
      await grant(first, staff.id);
      const institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
      expect((await revoke(first, staff.id, institutionAdmin.token)).status).toBe(403);
      const other = await makeSociety();
      const ownerB = await fixtures.owner(other);
      expect((await revoke(first, staff.id, ownerB.token)).status).toBe(404);
      expect((await revoke(first, staff.id)).status).toBe(200);
      expect((await revoke(first, staff.id)).status).toBe(404);
    });
  });

  describe('what a record takes with it', () => {
    it('STF-05 revokes every Admin grant of the record and ends the Admin sessions, and says so in the audit entry', async () => {
      const staff = await added();
      await api('put', `/v1/staff/${staff.id}/institutions`, owner.token, {
        institutionIds: [second],
      });
      await grant(first, staff.id);
      await grant(second, staff.id);
      const { token } = await actingAs(staff.person.email, ADMIN);
      expect((await api('delete', `/v1/staff/${staff.id}`, owner.token)).status).toBe(200);

      expect((await reads(token, first)).status).toBe(401);
      expect((await grantRows(staff.id)).map((row) => row.revoke_reason)).toEqual([
        'staff_deactivated',
        'staff_deactivated',
      ]);
      expect((await admins(first)).body.data).toEqual([]);
      const entry = (await audit(staff.id)).find((row) => row.action === 'staff.deactivated');
      expect(entry?.new_values).toMatchObject({
        adminRevoked: expect.arrayContaining([first, second]),
      });
    });

    it('STF-13 revokes the Admin grants of a record that moves to another person, who is not an Admin', async () => {
      const staff = await added();
      await grant(first, staff.id);
      const { token } = await actingAs(staff.person.email, ADMIN);
      const to = `${newId()}@moved.test`;
      const moved = await api('put', `/v1/staff/${staff.id}/email`, owner.token, {
        email: to,
        version: staff.version,
      });
      expect(moved.status).toBe(200);
      const after = moved.body.data as unknown as StaffData;
      expect(after.person.id).not.toBe(staff.person.id);
      staffUsers.push(after.person.id);

      expect((await reads(token, first)).status).toBe(401);
      expect((await grantRows(staff.id)).map((row) => row.revoke_reason)).toEqual(['staff_moved']);
      expect((await admins(first)).body.data).toEqual([]);
      const newcomer = await signInMobile(t, to);
      expect(newcomer.contexts.map((c) => c.roleCode)).toEqual([TEACHER]);
      const entry = (await audit(staff.id)).find((row) => row.action === 'staff.email_changed');
      expect(entry?.new_values).toMatchObject({ outcome: 'moved', adminRevoked: [first] });
    });

    it('STF-10 will not drop an extra Institution the person administers, until the access is revoked', async () => {
      const staff = await added();
      await api('put', `/v1/staff/${staff.id}/institutions`, owner.token, {
        institutionIds: [second],
      });
      await grant(second, staff.id);
      const held = await api('put', `/v1/staff/${staff.id}/institutions`, owner.token, {
        institutionIds: [],
      });
      expect(held.status).toBe(409);
      expect(held.body.code).toBe('ADMIN_ACCESS_HELD');
      expect(
        (await api('get', `/v1/staff/${staff.id}`, owner.token)).body.data.institutionIds,
      ).toEqual([second]);
      await revoke(second, staff.id);
      expect(
        (
          await api('put', `/v1/staff/${staff.id}/institutions`, owner.token, {
            institutionIds: [],
          })
        ).status,
      ).toBe(200);
    });

    it('a block of the record stops the Admin role too, and lifting it brings it back', async () => {
      const staff = await added();
      await grant(first, staff.id);
      expect((await api('post', `/v1/staff/${staff.id}/block`, owner.token)).status).toBe(200);
      const login = await signInMobile(t, staff.person.email);
      expect(login.contexts.map((c) => [c.roleCode, c.isBlocked])).toEqual(
        expect.arrayContaining([[ADMIN, true]]),
      );
      await api('post', `/v1/staff/${staff.id}/unblock`, owner.token);
      const { token } = await actingAs(staff.person.email, ADMIN);
      expect((await reads(token, first)).status).toBe(200);
    });
  });

  it('keeps the grants and sessions of one Society out of reach of another: a database transaction for B sees none of A’s admin grants through the app', async () => {
    const staff = await added();
    await grant(first, staff.id);
    const other = await makeSociety();
    const ownerB = await fixtures.owner(other);
    const rows = await database.transaction({ societyId: other }, (tx) =>
      tx.selectFrom('staff_members').select('id').where('id', '=', staff.id).execute(),
    );
    expect(rows).toEqual([]);
    expect((await grant(first, staff.id, ownerB.token)).status).toBe(404);
  });
});
