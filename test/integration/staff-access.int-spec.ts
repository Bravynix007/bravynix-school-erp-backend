import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService, type Database } from '../../src/platform/database/index.js';
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
const OWNER = 2;

interface StaffData {
  id: string;
  version: number;
  isBlocked: boolean;
  blockedAt: string | null;
  subjectIds: string[];
  institutionIds: string[];
  person: { id: string; email: string };
}

const settingsOf = (tenant: { societyId: string; personId: string }) => ({
  role: '2',
  society: tenant.societyId,
  person: tenant.personId,
});
const blockedIn = (society: string, person: string) => (tx: Transaction<Database>) =>
  sql<{
    blocked: boolean;
  }>`select app_staff_blocked(${society}::uuid, ${person}::uuid) as blocked`
    .execute(tx)
    .then((r) => r.rows[0]?.blocked);
const extraIn = (society: string, person: string) => (tx: Transaction<Database>) =>
  sql<{
    id: string;
  }>`select i.id from app_staff_extra_institutions(${society}::uuid, ${person}::uuid) as i(id)`
    .execute(tx)
    .then((r) => r.rows.map((row) => row.id));

/** STF-06 to STF-08 and STF-10 (API design 9.5): what a staff member may do in the Society. */
describe('staff access: block, subjects and extra Institutions', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const staffUsers: string[] = [];

  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
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

  const staffBody = (fields: object = {}) => ({
    homeInstitutionId: first,
    email: `${newId()}@staff.test`,
    firstName: 'Meera',
    classCategoryId: categoryId,
    mobile: { countryCode: '91', number: '9876500001' },
    ...fields,
  });

  const added = async (fields: object = {}, token = owner.token) => {
    const res = await api('post', '/v1/staff', token, staffBody(fields));
    expect(res.status).toBe(201);
    const staff = res.body.data as unknown as StaffData;
    // A person who was already there is removed with the fixtures, not before the people they made.
    if (!('email' in fields)) staffUsers.push(staff.person.id);
    return staff;
  };

  const makeSubject = async (name = `Physics ${newId().slice(-6)}`, token = owner.token) => {
    const res = await api('post', '/v1/subjects', token, { name });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };

  const secondSociety = async () => {
    const society = await makeSociety();
    const ownerOfB = await fixtures.owner(society);
    const institution = await makeInstitution(ownerOfB.token);
    return { society, ownerOfB, institution };
  };

  const block = (id: string, token = owner.token) => api('post', `/v1/staff/${id}/block`, token);
  const unblock = (id: string, token = owner.token) =>
    api('post', `/v1/staff/${id}/unblock`, token);
  const setSubjects = (id: string, subjectIds: unknown, token = owner.token) =>
    api('put', `/v1/staff/${id}/subjects`, token, { subjectIds });
  const setInstitutions = (id: string, institutionIds: unknown, token = owner.token) =>
    api('put', `/v1/staff/${id}/institutions`, token, { institutionIds });
  const read = async (id: string) =>
    (await api('get', `/v1/staff/${id}`, owner.token)).body.data as unknown as StaffData;

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

  const asTeacherReads = (token: string, institution: string) =>
    api('get', `/v1/fixtures/tenant/institutions/${institution}`, token);

  const asked = (
    tenant: { societyId: string; personId: string },
    work: (tx: Transaction<Database>) => Promise<unknown>,
  ) =>
    database.transaction(
      { societyId: tenant.societyId, roleCode: 2, personId: tenant.personId },
      async (tx) => {
        const result = await work(tx);
        const settings = await sql<{ role: string; society: string; person: string }>`
          select current_setting('app.role_code') as role, current_setting('app.society_id') as society,
            current_setting('app.person_id') as person`.execute(tx);
        return { result, settings: settings.rows[0] };
      },
    );

  /** A write that bypasses the API: the block is there, but nothing ended the sessions. */
  const blockBehindTheApi = (id: string, on: boolean) =>
    ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(trx);
      await sql`select set_config('app.society_id', ${societyA}, true)`.execute(trx);
      await sql`
        update staff_members
        set access_blocked_at = ${on ? sql`now()` : null}, access_blocked_by = ${on ? owner.person : null}
        where id = ${id}`.execute(trx);
    });

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
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
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

  describe('STF-06 and STF-07 block and unblock', () => {
    it('blocks the staff role: sessions end at once, the context shows isBlocked and refuses to be chosen, and unblocking restores it', async () => {
      const staff = await added();
      const { token, login } = await actingAs(staff.person.email, TEACHER);
      expect((await api('get', `/v1/staff/${staff.id}`, token)).status).toBe(200);

      const res = await block(staff.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: staff.id, isBlocked: true, version: 2 });
      expect(res.body.data.blockedAt).toEqual(expect.any(String));

      // The open session ended, with the reason a client reads.
      const ended = await api('get', `/v1/staff/${staff.id}`, token);
      expect(ended.status).toBe(401);
      expect(ended.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'blocked' } });
      expect((await api('get', '/v1/me', login.accessToken)).status).toBe(401);

      // They can still sign in; the context says it is blocked and cannot be chosen.
      const again = await signInMobile(t, staff.person.email);
      expect(again.contexts).toEqual([
        { roleCode: TEACHER, societyId: societyA, societyName: 'Sunrise Trust', isBlocked: true },
      ]);
      const refused = await api('post', '/v1/auth/context', again.accessToken, {
        roleCode: TEACHER,
        societyId: societyA,
      });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('ACCESS_BLOCKED');

      expect((await unblock(staff.id)).body.data).toMatchObject({
        isBlocked: false,
        blockedAt: null,
      });
      const { token: back } = await actingAs(staff.person.email, TEACHER);
      expect((await api('get', `/v1/staff/${staff.id}`, back)).status).toBe(200);
    });

    it('stops a session that was open when the block was written behind the API: 403 ACCESS_BLOCKED on every call but the open ones', async () => {
      const staff = await added();
      const { token } = await actingAs(staff.person.email, TEACHER);
      await blockBehindTheApi(staff.id, true);
      const stopped = await api('get', `/v1/staff/${staff.id}`, token);
      expect(stopped.status).toBe(403);
      expect(stopped.body).toMatchObject({
        code: 'ACCESS_BLOCKED',
        message: 'Your access has been blocked, please contact your Institution',
      });
      const me = await api('get', '/v1/me', token);
      expect(me.status).toBe(200);
      expect((me.body.data as unknown as { contexts: unknown[] }).contexts[0]).toMatchObject({
        roleCode: TEACHER,
        isBlocked: true,
      });
      await blockBehindTheApi(staff.id, false);
      expect((await api('get', `/v1/staff/${staff.id}`, token)).status).toBe(200);
    });

    it('blocks the Institution Admin role of the same person in the Society too, and leaves their Owner role and their other Societies alone', async () => {
      // One person: Institution Admin and staff of Society A, staff of Society B, Owner of Society C.
      const person = await fixtures.institutionAdmin(societyA, [first]);
      const staff = await added({ email: person.email });
      expect(staff.person.id).toBe(person.person);
      const { society: societyB, ownerOfB, institution } = await secondSociety();
      const inB = await added(
        { email: person.email, homeInstitutionId: institution },
        ownerOfB.token,
      );
      const societyC = await makeSociety();
      await sql`insert into role_assignments (user_id, role_code, society_id, seat_no)
        values (${person.person}, 2, ${societyC}, 1)`.execute(ownerDb);
      expect(inB.person.id).toBe(person.person);

      const asAdmin = await actingAs(person.email, ADMIN);
      expect((await block(staff.id)).status).toBe(200);
      expect((await api('get', '/v1/me', asAdmin.token)).status).toBe(401);

      const login = await signInMobile(t, person.email);
      const flagged = login.contexts.map((c) => `${c.roleCode}:${c.societyId}:${c.isBlocked}`);
      expect(flagged.toSorted()).toEqual(
        [
          `${ADMIN}:${societyA}:true`,
          `${TEACHER}:${societyA}:true`,
          `${TEACHER}:${societyB}:false`,
          `${OWNER}:${societyC}:false`,
        ].toSorted(),
      );
      for (const [roleCode, societyId] of [
        [TEACHER, societyB],
        [OWNER, societyC],
      ] as const) {
        const chosen = await api('post', '/v1/auth/context', login.accessToken, {
          roleCode,
          societyId,
        });
        expect(chosen.status).toBe(200);
        expect((await api('get', '/v1/me', chosen.body.data.accessToken as string)).status).toBe(
          200,
        );
      }
    });

    it('leaves the Owner role of the same person in the same Society working: the open token, the context and AUTH-06', async () => {
      // The Owner of Society A is also a staff member of it, and the Admin of the home Institution blocks that record.
      const staff = await added({ email: owner.email });
      const asOwner = await actingAs(owner.email, OWNER);
      expect((await block(staff.id, institutionAdmin.token)).status).toBe(200);

      expect((await api('get', '/v1/staff', asOwner.token)).status).toBe(200);
      const login = await signInMobile(t, owner.email);
      const flagged = login.contexts.map((c) => `${c.roleCode}:${c.isBlocked}`);
      expect(flagged.toSorted()).toEqual([`${OWNER}:false`, `${TEACHER}:true`]);
      const chosen = await api('post', '/v1/auth/context', login.accessToken, {
        roleCode: OWNER,
        societyId: societyA,
      });
      expect(chosen.status).toBe(200);
      const refused = await api('post', '/v1/auth/context', login.accessToken, {
        roleCode: TEACHER,
        societyId: societyA,
      });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('ACCESS_BLOCKED');
    });

    it('ends only the sessions of the Society it is written in: a session open in another Society goes on', async () => {
      const staff = await added();
      const { society: societyB, ownerOfB, institution } = await secondSociety();
      await added({ email: staff.person.email, homeInstitutionId: institution }, ownerOfB.token);
      const inA = await actingAs(staff.person.email, TEACHER);
      const inB = await actingAs(staff.person.email, TEACHER, societyB);
      expect((await block(staff.id)).status).toBe(200);
      expect((await api('get', '/v1/me', inA.token)).status).toBe(401);
      expect((await api('get', '/v1/me', inB.token)).status).toBe(200);
      const entry = (await audit(staff.id)).find((row) => row.action === 'staff.blocked');
      expect(entry?.new_values).toMatchObject({ sessionsEnded: 1 });
    });

    it('shows the block on the profile and in the list, which filters by it', async () => {
      const blocked = await added({ firstName: 'Asha' });
      const open = await added({ firstName: 'Dev' });
      await block(blocked.id);
      expect((await read(blocked.id)).isBlocked).toBe(true);
      const names = async (query: string) =>
        (
          (await api('get', `/v1/staff${query}`, owner.token)).body.data as unknown as {
            firstName: string;
            isBlocked: boolean;
          }[]
        ).map((row) => `${row.firstName}:${String(row.isBlocked)}`);
      expect(await names('')).toEqual(['Asha:true', 'Dev:false']);
      expect(await names('?blocked=true')).toEqual(['Asha:true']);
      expect(await names('?blocked=false')).toEqual(['Dev:false']);
      expect((await api('get', '/v1/staff?blocked=maybe', owner.token)).status).toBe(400);
      expect(open.isBlocked).toBe(false);
    });

    it('audits the block and the lift, with the sessions ended', async () => {
      const staff = await added();
      await actingAs(staff.person.email, TEACHER);
      await block(staff.id);
      await unblock(staff.id);
      const rows = await audit(staff.id);
      const byAction = (action: string) => rows.find((row) => row.action === action);
      expect(byAction('staff.blocked')).toMatchObject({
        old_values: { isBlocked: false },
        new_values: { isBlocked: true, sessionsEnded: 1 },
      });
      expect(byAction('staff.unblocked')).toMatchObject({
        old_values: { isBlocked: true },
        new_values: { isBlocked: false },
      });
    });

    it('refuses a record that is already blocked, one that is not, the caller’s own, and a deactivated one', async () => {
      const staff = await added();
      expect((await unblock(staff.id)).body.code).toBe('INVALID_STATE');
      expect((await block(staff.id)).status).toBe(200);
      const twice = await block(staff.id);
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('INVALID_STATE');

      const own = await added({ email: owner.email });
      const self = await block(own.id);
      expect(self.status).toBe(409);
      expect(self.body.code).toBe('CANNOT_ACT_ON_SELF');
      expect((await unblock(own.id)).body.code).toBe('CANNOT_ACT_ON_SELF');

      const gone = await added();
      expect((await api('delete', `/v1/staff/${gone.id}`, owner.token)).status).toBe(200);
      expect((await block(gone.id)).status).toBe(404);
      expect((await unblock(gone.id)).status).toBe(404);
    });

    it('is for Owners and the Admin of the home Institution only: a teacher, an Admin of another Institution and another Society’s Owner get nothing', async () => {
      const staff = await added();
      const colleague = await added({ homeInstitutionId: second });
      const teacher = await actingAs(staff.person.email, TEACHER);
      expect((await block(staff.id, teacher.token)).status).toBe(403);
      expect((await block(colleague.id, institutionAdmin.token)).status).toBe(404);
      const { ownerOfB } = await secondSociety();
      expect((await block(staff.id, ownerOfB.token)).status).toBe(404);
      expect((await read(staff.id)).isBlocked).toBe(false);
      // The Admin of the home Institution may.
      expect((await block(staff.id, institutionAdmin.token)).status).toBe(200);
    });
  });

  describe('STF-08 subjects', () => {
    it('sets, reads back, replaces and clears the list, and the list filters by subject', async () => {
      const staff = await added();
      const other = await added();
      const [physics, maths] = [await makeSubject(), await makeSubject()];
      const set = await setSubjects(staff.id, [physics, maths]);
      expect(set.status).toBe(200);
      expect((set.body.data as unknown as StaffData).subjectIds.toSorted()).toEqual(
        [physics, maths].toSorted(),
      );
      expect((await read(staff.id)).subjectIds.toSorted()).toEqual([physics, maths].toSorted());

      await setSubjects(other.id, [maths]);
      const ids = async (subject: string) =>
        (
          (await api('get', `/v1/staff?subjectId=${subject}`, owner.token)).body
            .data as unknown as StaffData[]
        )
          .map((row) => row.id)
          .toSorted();
      expect(await ids(maths)).toEqual([staff.id, other.id].toSorted());
      expect(await ids(physics)).toEqual([staff.id]);

      expect((await setSubjects(staff.id, [maths])).body.data.subjectIds).toEqual([maths]);
      expect((await setSubjects(staff.id, [])).body.data.subjectIds).toEqual([]);
      expect(await ids(physics)).toEqual([]);
    });

    it('writes nothing for the same list, and audits a change with before and after', async () => {
      const staff = await added();
      const subject = await makeSubject();
      await setSubjects(staff.id, [subject]);
      const entries = async () =>
        (await audit(staff.id)).filter((row) => row.action === 'staff.subjects_changed');
      expect(await entries()).toHaveLength(1);
      expect((await entries())[0]).toMatchObject({
        old_values: { subjectIds: [] },
        new_values: { subjectIds: [subject] },
      });
      expect((await setSubjects(staff.id, [subject])).status).toBe(200);
      expect(await entries()).toHaveLength(1);
    });

    it('refuses a subject that is not in the Society (404), one that is hidden (422), a repeat and a bad ID (400), changing nothing', async () => {
      const staff = await added();
      const kept = await makeSubject();
      await setSubjects(staff.id, [kept]);
      const { ownerOfB } = await secondSociety();
      const foreign = await makeSubject('Chemistry', ownerOfB.token);
      expect((await setSubjects(staff.id, [kept, foreign])).status).toBe(404);
      expect((await setSubjects(staff.id, [kept, newId()])).status).toBe(404);

      const hidden = await makeSubject();
      expect((await api('delete', `/v1/subjects/${hidden}`, owner.token)).status).toBe(200);
      const inactive = await setSubjects(staff.id, [kept, hidden]);
      expect(inactive.status).toBe(422);
      expect(inactive.body.code).toBe('REFERENCE_INACTIVE');

      expect((await setSubjects(staff.id, [kept, kept])).status).toBe(400);
      expect((await setSubjects(staff.id, ['nope'])).status).toBe(400);
      expect((await setSubjects(staff.id, kept)).status).toBe(400);
      expect((await read(staff.id)).subjectIds).toEqual([kept]);
    });

    it('lets a subject that was deactivated after it was given stay on the list', async () => {
      const staff = await added();
      const subject = await makeSubject();
      const other = await makeSubject();
      await setSubjects(staff.id, [subject]);
      expect((await api('delete', `/v1/subjects/${subject}`, owner.token)).status).toBe(200);
      expect((await setSubjects(staff.id, [subject, other])).status).toBe(200);
      expect((await read(staff.id)).subjectIds.toSorted()).toEqual([subject, other].toSorted());
    });

    it('is for admins of the home Institution: a teacher is 403, another Institution’s Admin 404, a deactivated record 404', async () => {
      const staff = await added();
      const colleague = await added({ homeInstitutionId: second });
      const teacher = await actingAs(staff.person.email, TEACHER);
      expect((await setSubjects(staff.id, [], teacher.token)).status).toBe(403);
      expect((await setSubjects(colleague.id, [], institutionAdmin.token)).status).toBe(404);
      expect((await setSubjects(staff.id, [], institutionAdmin.token)).status).toBe(200);
      const gone = await added();
      await api('delete', `/v1/staff/${gone.id}`, owner.token);
      expect((await setSubjects(gone.id, [])).status).toBe(404);
    });

    it('is hidden from another Society by row-level security', async () => {
      const staff = await added();
      await setSubjects(staff.id, [await makeSubject()]);
      const { society } = await secondSociety();
      const rows = await database.transaction({ societyId: society }, (tx) =>
        tx.selectFrom('staff_subjects').selectAll().execute(),
      );
      expect(rows).toEqual([]);
      const mine = await database.transaction({ societyId: societyA }, (tx) =>
        tx.selectFrom('staff_subjects').selectAll().execute(),
      );
      expect(mine).toHaveLength(1);
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`update staff_subjects set created_by = null`.execute(tx),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('STF-10 extra Institutions', () => {
    it('widens the teacher’s reach to the extra Institutions from their next call, and takes it back when the list changes', async () => {
      const staff = await added();
      const { token } = await actingAs(staff.person.email, TEACHER);
      expect((await asTeacherReads(token, first)).status).toBe(200);
      expect((await asTeacherReads(token, second)).status).toBe(404);

      const set = await setInstitutions(staff.id, [second]);
      expect(set.status).toBe(200);
      expect((set.body.data as unknown as StaffData).institutionIds).toEqual([second]);
      expect((await read(staff.id)).institutionIds).toEqual([second]);
      expect((await asTeacherReads(token, second)).status).toBe(200);
      // The home Institution is still the home one: the record is read through it.
      expect((await api('get', `/v1/staff/${staff.id}`, token)).status).toBe(200);

      expect((await setInstitutions(staff.id, [])).body.data.institutionIds).toEqual([]);
      expect((await asTeacherReads(token, second)).status).toBe(404);
    });

    it('counts the context as blocked only when every Institution the teacher reaches has its staff section blocked', async () => {
      const staff = await added();
      await setInstitutions(staff.id, [second]);
      await blocks.setBlock(ownerDb, societyA, first, 2, true);

      // The home Institution is stopped, the extra one is not: the context is open and works where it can.
      const { token, login } = await actingAs(staff.person.email, TEACHER);
      expect(login.contexts).toEqual([
        { roleCode: TEACHER, societyId: societyA, societyName: 'Sunrise Trust', isBlocked: false },
      ]);
      expect((await asTeacherReads(token, second)).status).toBe(200);
      expect((await asTeacherReads(token, first)).status).toBe(423);

      // Once the extra one is stopped too, nothing is left. A section block still lets the person choose the
      // context, to read why (API design 6.3); the gate stops the calls.
      await blocks.setBlock(ownerDb, societyA, second, 2, true);
      const me = await api('get', '/v1/me', token);
      expect((me.body.data as unknown as { contexts: unknown[] }).contexts[0]).toMatchObject({
        roleCode: TEACHER,
        isBlocked: true,
      });
      expect((await asTeacherReads(token, second)).status).toBe(423);
    });

    it('does not make the Admin of the home Institution reach the extra one', async () => {
      const staff = await added();
      await setInstitutions(staff.id, [second]);
      expect((await api('get', `/v1/staff/${staff.id}`, institutionAdmin.token)).status).toBe(200);
      expect((await asTeacherReads(institutionAdmin.token, second)).status).toBe(404);
    });

    it('is for Society Owners: an Institution Admin gets 403', async () => {
      const staff = await added();
      const res = await setInstitutions(staff.id, [second], institutionAdmin.token);
      expect(res.status).toBe(403);
      expect((await read(staff.id)).institutionIds).toEqual([]);
    });

    it('refuses the home Institution (400, at its place in the list), another Society’s Institution (404) and a deactivated one (422)', async () => {
      const staff = await added();
      const home = await setInstitutions(staff.id, [second, first]);
      expect(home.status).toBe(400);
      expect(home.body.errors).toEqual([
        expect.objectContaining({ field: 'institutionIds[1]', code: 'INVALID_VALUE' }),
      ]);
      const { institution: foreign } = await secondSociety();
      expect((await setInstitutions(staff.id, [foreign])).status).toBe(404);
      expect((await setInstitutions(staff.id, [newId()])).status).toBe(404);

      const closed = await makeInstitution(owner.token);
      expect((await api('delete', `/v1/institutions/${closed}`, owner.token)).status).toBe(200);
      const inactive = await setInstitutions(staff.id, [closed]);
      expect(inactive.status).toBe(422);
      expect(inactive.body.code).toBe('REFERENCE_INACTIVE');
      expect((await setInstitutions(staff.id, [second, second])).status).toBe(400);
      expect((await setInstitutions(staff.id, second)).status).toBe(400);
      expect((await read(staff.id)).institutionIds).toEqual([]);
    });

    it('writes nothing for the same list, and audits a change with before and after', async () => {
      const staff = await added();
      await setInstitutions(staff.id, [second]);
      await setInstitutions(staff.id, [second]);
      const entries = (await audit(staff.id)).filter(
        (row) => row.action === 'staff.institutions_changed',
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        old_values: { institutionIds: [] },
        new_values: { institutionIds: [second] },
      });
    });

    it('keeps the list after the Institution is deactivated, but the teacher no longer reaches it', async () => {
      const staff = await added();
      const extra = await makeInstitution(owner.token);
      await setInstitutions(staff.id, [extra]);
      const { token } = await actingAs(staff.person.email, TEACHER);
      expect((await asTeacherReads(token, extra)).status).toBe(200);
      expect((await api('delete', `/v1/institutions/${extra}`, owner.token)).status).toBe(200);
      expect((await asTeacherReads(token, extra)).status).toBe(404);
      expect((await api('get', `/v1/staff/${staff.id}`, token)).status).toBe(200);
    });
  });

  describe('the definer functions of migration 0027', () => {
    it('answer only for the person and Society asked about, from any tenant, and put the settings back', async () => {
      const staff = await added();
      const { society: societyB, ownerOfB, institution } = await secondSociety();
      const inB = await added(
        { email: staff.person.email, homeInstitutionId: institution },
        ownerOfB.token,
      );
      await setInstitutions(staff.id, [second]);
      await block(inB.id, ownerOfB.token);
      const fromA = { societyId: societyA, personId: owner.person };
      const fromB = { societyId: societyB, personId: ownerOfB.person };
      // Blocked in B only, and from either tenant.
      expect(await asked(fromA, blockedIn(societyB, staff.person.id))).toEqual({
        result: true,
        settings: settingsOf(fromA),
      });
      expect(await asked(fromB, blockedIn(societyA, staff.person.id))).toEqual({
        result: false,
        settings: settingsOf(fromB),
      });
      // Nobody else is answered for: the Owner of B and a stranger hold no blocked record.
      expect((await asked(fromA, blockedIn(societyB, ownerOfB.person))).result).toBe(false);
      expect((await asked(fromA, blockedIn(societyB, newId()))).result).toBe(false);
      // The extra Institutions of the record in A, only for A, and none for the record in B.
      expect(await asked(fromB, extraIn(societyA, staff.person.id))).toEqual({
        result: [second],
        settings: settingsOf(fromB),
      });
      expect((await asked(fromA, extraIn(societyB, staff.person.id))).result).toEqual([]);
      expect((await asked(fromA, extraIn(societyA, ownerOfB.person))).result).toEqual([]);
      // An ended record answers neither.
      await api('delete', `/v1/staff/${staff.id}`, owner.token);
      expect((await asked(fromB, extraIn(societyA, staff.person.id))).result).toEqual([]);
      await api('delete', `/v1/staff/${inB.id}`, ownerOfB.token);
      expect((await asked(fromA, blockedIn(societyB, staff.person.id))).result).toBe(false);
    });

    it('do not read the records of the other Societies when the caller’s own tenant is the person', async () => {
      const staff = await added();
      const { society: societyB, ownerOfB, institution } = await secondSociety();
      await added({ email: staff.person.email, homeInstitutionId: institution }, ownerOfB.token);
      await block(staff.id);
      // Blocked in A, not in B: asked about B, by the person themselves in B, the answer is no.
      const self = { societyId: societyB, personId: staff.person.id };
      expect((await asked(self, blockedIn(societyB, staff.person.id))).result).toBe(false);
      expect((await asked(self, blockedIn(societyA, staff.person.id))).result).toBe(true);
    });
  });

  describe('the tables of migration 0027 refuse what the policies and keys forbid', () => {
    it('does not let one Society write rows for another, in either list', async () => {
      const { society: societyB, ownerOfB, institution } = await secondSociety();
      const inB = await added({ homeInstitutionId: institution }, ownerOfB.token);
      const subjectInB = await makeSubject(undefined, ownerOfB.token);
      // Foreign keys skip row-level security, so only the insert policy stops a tenant naming another Society.
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`insert into staff_subjects (staff_member_id, subject_id, society_id)
            values (${inB.id}, ${subjectInB}, ${societyB})`.execute(tx),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`insert into staff_institutions (staff_member_id, institution_id, society_id)
            values (${inB.id}, ${institution}, ${societyB})`.execute(tx),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('does not let a list point across Societies, or a block be half written', async () => {
      const staff = await added();
      const { institution } = await secondSociety();
      // The Institution is another Society's: the composite key (id, society) has no such row.
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`insert into staff_institutions (staff_member_id, institution_id, society_id)
            values (${staff.id}, ${institution}, ${societyA})`.execute(tx),
        ),
      ).rejects.toThrow(/fk_staff_institutions_institution/);
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`update staff_members set access_blocked_at = now() where id = ${staff.id}`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/ck_staff_members_access_block/);
    });
  });
});
