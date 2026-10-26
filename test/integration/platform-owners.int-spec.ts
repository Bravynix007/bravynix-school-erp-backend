import { Kysely, PostgresDialect, sql } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import type { Principal } from '../../src/common/auth/access-token-verifier.js';
import { RoleCode } from '../../src/common/auth/roles.js';
import { ErrorCode } from '../../src/common/http/error-codes.js';
import { createPool, DatabaseService } from '../../src/platform/database/database.service.js';
import { platformTenant } from '../../src/platform/database/platform-tenant.js';
import type { Tx } from '../../src/platform/database/index.js';
import { AccountDirectory } from '../../src/platform/identity/index.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { superAdminToken } from '../support/admin-token.js';
import { apiCaller } from '../support/api.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { removeScratchPeople, scratchEmail } from '../support/scratch-people.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const seededOwner = personaByKey('SO-A1');
const missing = '00000000-0000-7000-8000-00000000ffff';

interface OwnerRow {
  id: string;
  email: string;
  displayName: string;
  accountStatus: number;
  blockedAt: string | null;
  blockReason: string | null;
  version: number;
  seatNo: number;
  society: { id: string; code: string; name: string };
}

describe('PLT-03, PLT-09 to PLT-11 Society Owners', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const emails: string[] = [];

  /** A new address, removed after the test. */
  const email = () => {
    const made = scratchEmail();
    emails.push(made);
    return made;
  };

  const createSociety = async (fields: Record<string, unknown> = {}) => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Education Trust',
      code: `S${newId().slice(-12)}`,
      ...fields,
    });
    if (res.status === 201) societies.push(res.body.data.id);
    return res;
  };

  const addOwner = (societyId: string, body: object) =>
    api('post', `/v1/platform/societies/${societyId}/owners`, admin, body);

  const auditOf = (societyId: string, like: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      entity_id: string;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`society_id = ${societyId} and action like ${like}`);

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    api = apiCaller(t);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    await removeScratchPeople(ownerDb, emails.splice(0));
  });

  describe('who may call', () => {
    it('refuses a Society Owner and a signed-out caller on every route', async () => {
      const society = (await createSociety()).body.data.id;
      const owner = await addOwner(society, { email: email() });
      const ownerEmail = owner.body.data.email as string;
      const login = await signInMobile(t, ownerEmail);
      const routes = [
        ['post', `/v1/platform/societies/${society}/owners`],
        ['delete', `/v1/platform/societies/${society}/owners/${owner.body.data.id}`],
        ['get', '/v1/platform/society-owners'],
      ] as const;
      for (const [method, path] of routes) {
        expect((await api(method, path, login.accessToken, { email: email() })).status).toBe(403);
        expect((await api(method, path, 'not-a-token', { email: email() })).status).toBe(401);
      }
    });
  });

  describe('PLT-09 add an Owner', () => {
    it('makes a Pending account in the lowest free seat, welcomes them and audits it in the Society', async () => {
      const society = (await createSociety({ name: 'Sunrise Trust' })).body.data.id;
      const address = email();
      const res = await addOwner(society, {
        email: address.toUpperCase(),
        firstName: 'Asha',
        lastName: 'Rao',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        id: expect.any(String),
        email: address,
        displayName: 'Asha Rao',
        societyId: society,
        seatNo: 1,
      });

      const { rows } = await sql<{ account_status: number; created_by: string }>`
        select account_status, created_by from users where email = ${address}`.execute(ownerDb);
      expect(rows[0]).toEqual({ account_status: 3, created_by: superAdmin.id });

      await t.app.get(OtpService).flush();
      const mail = t.email.latest(address, 'welcome')!;
      expect(mail.text).toContain('Society Owner of Sunrise Trust');
      expect(mail.text).not.toMatch(/https?:/);

      const audit = await auditOf(society, 'owner.%');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'owner.add',
        actor_user_id: superAdmin.id,
        entity_id: res.body.data.id,
      });
      expect(JSON.stringify(audit[0])).not.toContain(address);
    });

    it('is the person’s Owner context when they sign in, and shows in the Society’s owners', async () => {
      const society = (await createSociety()).body.data.id;
      const address = email();
      await addOwner(society, { email: address });
      const login = await signInMobile(t, address);
      expect(login.contexts).toEqual([{ roleCode: 2, societyId: society }]);
      const detail = await api('get', `/v1/platform/societies/${society}`, admin);
      expect(detail.body.data.owners).toEqual([
        expect.objectContaining({ email: address, accountStatus: 1 }),
      ]);
    });

    it('stops at three Owners, and a freed seat is used again', async () => {
      const society = (await createSociety()).body.data.id;
      const added = [];
      for (let seat = 1; seat <= 3; seat++) {
        const res = await addOwner(society, { email: email() });
        expect(res.body.data.seatNo).toBe(seat);
        added.push(res.body.data.id);
      }
      const fourth = await addOwner(society, { email: email() });
      expect(fourth.status).toBe(409);
      expect(fourth.body.code).toBe('SEAT_LIMIT_REACHED');

      await api('delete', `/v1/platform/societies/${society}/owners/${added[1]}`, admin);
      const again = await addOwner(society, { email: email() });
      expect(again.status).toBe(201);
      expect(again.body.data.seatNo).toBe(2);
    });

    it('gives an existing person the Owner role as well: one email is one person', async () => {
      const society = (await createSociety()).body.data.id;
      const res = await addOwner(society, { email: seededOwner.email });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe(seededOwner.id);
      const login = await signInMobile(t, seededOwner.email);
      expect(login.contexts).toEqual(expect.arrayContaining([{ roleCode: 2, societyId: society }]));
      await sql`delete from role_assignments where user_id = ${seededOwner.id} and society_id = ${society}`.execute(
        ownerDb,
      );
    });

    it('refuses the same person twice, a blocked person, a deactivated Society and an unknown one', async () => {
      const society = (await createSociety()).body.data.id;
      const address = email();
      expect((await addOwner(society, { email: address })).status).toBe(201);
      const twice = await addOwner(society, { email: address });
      expect(twice.status).toBe(409);
      expect(twice.body).toMatchObject({
        code: 'DUPLICATE',
        errors: [expect.objectContaining({ field: 'email' })],
      });

      const blocked = email();
      await sql`insert into users (email, account_status, blocked_at) values (${blocked}, 2, now())`.execute(
        ownerDb,
      );
      expect((await addOwner(society, { email: blocked })).body.code).toBe('ACCOUNT_BLOCKED');

      const other = (await createSociety()).body.data.id;
      await api('delete', `/v1/platform/societies/${other}`, admin);
      const gone = await addOwner(other, { email: email() });
      expect(gone.status).toBe(409);
      expect(gone.body.code).toBe('INVALID_STATE');

      expect((await addOwner(missing, { email: email() })).status).toBe(404);
      expect((await addOwner('not-an-id', { email: email() })).status).toBe(404);
    });

    it('validates the body', async () => {
      const society = (await createSociety()).body.data.id;
      for (const body of [{}, { email: 'nope' }, { email: email(), firstName: '' }]) {
        const res = await addOwner(society, body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      const extra = await addOwner(society, { email: email(), roleCode: 1 });
      expect(extra.body.errors).toContainEqual(
        expect.objectContaining({ field: 'roleCode', code: 'FIELD_NOT_ALLOWED' }),
      );
    });

    it('is not stopped by a paused Society: Super Admin is never stopped', async () => {
      const society = await createSociety();
      await api('post', `/v1/platform/societies/${society.body.data.id}/pause`, admin, {
        reason: 'Dues',
        version: society.body.data.version,
      });
      expect((await addOwner(society.body.data.id, { email: email() })).status).toBe(201);
    });
  });

  describe('PLT-03 Owners with the new Society', () => {
    it('creates the Society with its first Owners in one go, each welcomed and audited', async () => {
      const first = email();
      const second = email();
      const res = await createSociety({
        owners: [{ email: first }, { email: second, firstName: 'Ravi' }],
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        institutions: [],
        owners: [
          expect.objectContaining({ email: first }),
          expect.objectContaining({ email: second, displayName: 'Ravi' }),
        ],
      });
      await t.app.get(OtpService).flush();
      expect(t.email.latest(first, 'welcome')).toBeDefined();
      expect(t.email.latest(second, 'welcome')).toBeDefined();
      expect(await auditOf(res.body.data.id, 'owner.add')).toHaveLength(2);
    });

    it('makes nothing when an Owner cannot be added: the Society is not created either', async () => {
      const code = `S${newId().slice(-12)}`;
      const same = email();
      const res = await createSociety({ code, owners: [{ email: same }, { email: same }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE');
      expect(res.body.errors).toEqual([
        expect.objectContaining({ field: 'owners[1].email', code: 'DUPLICATE' }),
      ]);
      const { rows } = await sql`select 1 from users where email = ${same}`.execute(ownerDb);
      expect(rows).toHaveLength(0);
      const list = await api('get', `/v1/platform/societies?q=${code}`, admin);
      expect(list.body.data).toEqual([]);
    });

    it('refuses none, or four, Owners', async () => {
      expect((await createSociety({ owners: [] })).status).toBe(400);
      const four = await createSociety({
        owners: [email(), email(), email(), email()].map((address) => ({ email: address })),
      });
      expect(four.status).toBe(400);
    });
  });

  describe('PLT-10 remove an Owner', () => {
    it('revokes the grant, ends the Owner’s sessions in that Society and audits it', async () => {
      const society = (await createSociety()).body.data.id;
      const address = email();
      const added = await addOwner(society, { email: address });
      await addOwner(society, { email: email() });
      const login = await signInMobile(t, address);
      expect((await api('get', '/v1/me', login.accessToken)).status).toBe(200);

      const res = await api(
        'delete',
        `/v1/platform/societies/${society}/owners/${added.body.data.id}`,
        admin,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: added.body.data.id, status: 0 });

      const after = await api('get', '/v1/me', login.accessToken);
      expect(after.status).toBe(401);
      expect(after.body.code).toBe('SESSION_ENDED');
      expect(after.body.data).toMatchObject({ reason: 'admin_revoked' });
      expect(await signInMobile(t, address).then((again) => again.contexts)).toEqual([]);

      const { rows } = await sql<{ revoke_reason: string; revoked_by: string }>`
        select revoke_reason, revoked_by from role_assignments
        where user_id = ${added.body.data.id} and society_id = ${society}`.execute(ownerDb);
      expect(rows).toEqual([{ revoke_reason: 'owner_removed', revoked_by: superAdmin.id }]);
      const audit = await auditOf(society, 'owner.remove');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.new_values).toEqual({ sessions_ended: 1 });
    });

    it('refuses to remove the last Owner, and allows it once a replacement is added', async () => {
      const society = (await createSociety()).body.data.id;
      const only = (await addOwner(society, { email: email() })).body.data.id as string;
      const path = (id: string) => `/v1/platform/societies/${society}/owners/${id}`;

      const refused = await api('delete', path(only), admin);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('LAST_OWNER');
      expect(await auditOf(society, 'owner.remove')).toHaveLength(0);

      await addOwner(society, { email: email() });
      expect((await api('delete', path(only), admin)).status).toBe(200);
    });

    it('makes the second of two removals of the last two Owners wait for the first, then refuses it', async () => {
      const society = (await createSociety()).body.data.id as string;
      const first = (await addOwner(society, { email: email() })).body.data.id as string;
      const second = (await addOwner(society, { email: email() })).body.data.id as string;
      const database = t.app.get(DatabaseService);
      const directory = t.app.get(AccountDirectory);
      const principal = { personId: superAdmin.id, roleCode: RoleCode.SuperAdmin } as Principal;
      const seat = { roleCode: 2, societyId: society } as const;
      const remove = (tx: Tx, userId: string) =>
        directory.revoke(
          tx,
          seat,
          userId,
          superAdmin.id,
          'owner_removed',
          new Date(),
          ErrorCode.LAST_OWNER,
        );

      let commitFirst!: () => void;
      let firstHasRemoved!: () => void;
      const removed = new Promise<void>((resolve) => {
        firstHasRemoved = resolve;
      });
      const firstDone = database.transaction(platformTenant(principal, society), async (tx) => {
        await remove(tx, first);
        firstHasRemoved();
        await new Promise<void>((resolve) => {
          commitFirst = resolve;
        });
      });
      await removed;

      let secondSettled = false;
      const secondDone = database
        .transaction(platformTenant(principal, society), (tx) => remove(tx, second))
        .finally(() => {
          secondSettled = true;
        });
      const secondOutcome = secondDone.then(
        () => 'removed',
        (error: { code?: string }) => error.code,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondSettled).toBe(false);

      commitFirst();
      await firstDone;
      expect(await secondOutcome).toBe('LAST_OWNER');
    });

    it('answers 404 for a person who is not an Owner there, an unknown Society and bad IDs', async () => {
      const society = (await createSociety()).body.data.id;
      const other = (await createSociety()).body.data.id;
      const added = await addOwner(other, { email: email() });
      for (const path of [
        `/v1/platform/societies/${society}/owners/${added.body.data.id}`,
        `/v1/platform/societies/${society}/owners/${missing}`,
        `/v1/platform/societies/${missing}/owners/${added.body.data.id}`,
        `/v1/platform/societies/${society}/owners/not-an-id`,
      ]) {
        expect((await api('delete', path, admin)).status).toBe(404);
      }
    });
  });

  describe('PLT-11 Owners across Societies', () => {
    it('lists Owners with their Society, filters, sorts and pages', async () => {
      const one = (await createSociety({ name: 'Alpha Trust' })).body.data.id;
      const two = (await createSociety({ name: 'Beta Trust' })).body.data.id;
      const asha = email();
      const ravi = email();
      await addOwner(one, { email: asha, firstName: 'Asha', lastName: 'Zed' });
      await addOwner(two, { email: ravi, firstName: 'Ravi', lastName: 'Ark' });
      await addOwner(two, { email: email(), firstName: 'Meena' });

      const inOne = await api('get', `/v1/platform/society-owners?societyId=${one}`, admin);
      expect(inOne.status).toBe(200);
      expect((inOne.body.data as unknown as OwnerRow[]).map((row) => row.email)).toEqual([asha]);
      expect((inOne.body.data as unknown as OwnerRow[])[0]).toMatchObject({
        displayName: 'Asha Zed',
        accountStatus: 1,
        seatNo: 1,
        blockedAt: null,
        blockReason: null,
        version: expect.any(Number),
        society: { id: one, name: 'Alpha Trust' },
      });
      expect(inOne.body.meta).toMatchObject({ page: 1, totalItems: 1, totalPages: 1 });

      // The listed version is what PLT-15 and PLT-16 need: act on the Owner from this list alone.
      const listed = (inOne.body.data as unknown as OwnerRow[])[0]!;
      const block = await api('post', `/v1/platform/users/${listed.id}/block`, admin, {
        reason: 'Unpaid dues',
        version: listed.version,
      });
      expect(block.status).toBe(200);
      const blocked = (
        (await api('get', `/v1/platform/society-owners?societyId=${one}`, admin)).body
          .data as unknown as OwnerRow[]
      )[0]!;
      expect(blocked).toMatchObject({
        accountStatus: 2,
        blockReason: 'Unpaid dues',
        blockedAt: expect.any(String),
      });
      expect(blocked.version).toBeGreaterThan(listed.version);
      const unblock = await api('post', `/v1/platform/users/${listed.id}/unblock`, admin, {
        version: blocked.version,
      });
      expect(unblock.status).toBe(200);

      const byName = await api(
        'get',
        `/v1/platform/society-owners?societyId=${two}&sort=name`,
        admin,
      );
      expect((byName.body.data as unknown as OwnerRow[]).map((row) => row.displayName)).toEqual([
        'Meena',
        'Ravi Ark',
      ]);
      const byNameDesc = await api(
        'get',
        `/v1/platform/society-owners?societyId=${two}&sort=-name&limit=1&page=2`,
        admin,
      );
      expect((byNameDesc.body.data as unknown as OwnerRow[]).map((row) => row.displayName)).toEqual(
        ['Meena'],
      );
      expect(byNameDesc.body.meta).toMatchObject({
        page: 2,
        limit: 1,
        totalItems: 2,
        totalPages: 2,
      });

      const search = await api('get', `/v1/platform/society-owners?q=${ravi}`, admin);
      expect((search.body.data as unknown as OwnerRow[]).map((row) => row.email)).toEqual([ravi]);
      const byRaviName = await api('get', '/v1/platform/society-owners?q=ravi%20ark', admin);
      expect((byRaviName.body.data as unknown as OwnerRow[]).map((row) => row.email)).toContain(
        ravi,
      );
    });

    it('leaves out an Owner who was removed, and refuses bad queries', async () => {
      const society = (await createSociety()).body.data.id;
      const added = await addOwner(society, { email: email() });
      const kept = email();
      await addOwner(society, { email: kept });
      await api('delete', `/v1/platform/societies/${society}/owners/${added.body.data.id}`, admin);
      const list = await api('get', `/v1/platform/society-owners?societyId=${society}`, admin);
      expect((list.body.data as unknown as OwnerRow[]).map((row) => row.email)).toEqual([kept]);
      expect((await api('get', '/v1/platform/society-owners?sort=seat', admin)).body.code).toBe(
        'INVALID_SORT',
      );
      expect((await api('get', '/v1/platform/society-owners?societyId=nope', admin)).status).toBe(
        400,
      );
      expect((await api('get', '/v1/platform/society-owners?q=a', admin)).status).toBe(400);
    });
  });
});
