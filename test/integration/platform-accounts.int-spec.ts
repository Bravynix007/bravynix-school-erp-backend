import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpHasher } from '../../src/platform/identity/otp-hasher.js';
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
const otherAdmin = personaByKey('SA2');
const candidate = personaByKey('SA4-candidate');
const missing = '00000000-0000-7000-8000-00000000ffff';

describe('PLT-12 to PLT-18 and PLT-41 accounts', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const emails: string[] = [];

  const email = () => {
    const made = scratchEmail();
    emails.push(made);
    return made;
  };

  /** A Super Admin added through the API, with a console session token of their own. */
  const newAdmin = async () => {
    const address = email();
    const res = await api('post', '/v1/platform/super-admins', admin, { email: address });
    expect(res.status).toBe(201);
    return {
      id: res.body.data.id,
      email: address,
      token: await superAdminToken(t, ownerDb, res.body.data.id),
    };
  };

  /** A Society Owner added through the API, signed in on a phone. */
  const newOwner = async () => {
    const society = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    societies.push(society.body.data.id);
    const address = email();
    const added = await api(
      'post',
      `/v1/platform/societies/${society.body.data.id}/owners`,
      admin,
      {
        email: address,
      },
    );
    const login = await signInMobile(t, address);
    return { id: added.body.data.id, email: address, token: login.accessToken };
  };

  const giveAuthenticator = (userId: string, lockedUntil: string | null = null) =>
    sql`insert into user_totp_factors (user_id, secret_ciphertext, secret_key_version, confirmed_at, locked_until)
      values (${userId}, decode('00', 'hex'), 1, now(), ${lockedUntil})`.execute(ownerDb);

  const auditOf = (action: string, entityId: string) =>
    readAuditRows<{
      actor_user_id: string;
      reason: string | null;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`action = ${action} and entity_id = ${entityId}`);

  const accountStatus = async (userId: string) =>
    (
      await sql<{
        account_status: number;
      }>`select account_status from users where id = ${userId}`.execute(ownerDb)
    ).rows[0]!.account_status;

  const lockEmail = (address: string) => {
    const now = t.clock.now();
    return sql`insert into login_lockouts (email_hmac, created_at, locked_until)
      values (${t.app.get(OtpHasher).email(address)}, ${now.toISOString()}, ${new Date(now.getTime() + 3_600_000).toISOString()})`.execute(
      ownerDb,
    );
  };
  const askForCode = (address: string) =>
    request(t.app.getHttpServer()).post('/v1/auth/otp').send({ email: address, clientType: 1 });

  const versionOf = async (userId: string) =>
    (
      await sql<{ version: number }>`select version from users where id = ${userId}`.execute(
        ownerDb,
      )
    ).rows[0]!.version;

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
      const owner = await newOwner();
      const routes = [
        ['get', '/v1/platform/super-admins'],
        ['post', '/v1/platform/super-admins'],
        ['delete', `/v1/platform/super-admins/${otherAdmin.id}`],
        ['post', `/v1/platform/users/${otherAdmin.id}/block`],
        ['post', `/v1/platform/users/${otherAdmin.id}/unblock`],
        ['put', `/v1/platform/users/${otherAdmin.id}/email`],
        ['delete', `/v1/platform/users/${otherAdmin.id}/mfa`],
        ['post', `/v1/platform/users/${otherAdmin.id}/unlock`],
      ] as const;
      for (const [method, path] of routes) {
        expect((await api(method, path, owner.token, { email: email() })).status).toBe(403);
        expect((await api(method, path, 'not-a-token', { email: email() })).status).toBe(401);
      }
      expect(await accountStatus(otherAdmin.id)).toBe(1);
    });
  });

  describe('PLT-12 and PLT-13 Super Admins', () => {
    it('lists the seeded Super Admins by seat, with whether the authenticator is set up', async () => {
      const res = await api('get', '/v1/platform/super-admins', admin);
      expect(res.status).toBe(200);
      expect(res.body.meta).toBeNull();
      expect(res.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: superAdmin.id,
            accountStatus: 1,
            authenticatorSetUp: false,
          }),
          expect.objectContaining({ id: otherAdmin.id }),
        ]),
      );
      const seats = (res.body.data as unknown as { seatNo: number }[]).map((row) => row.seatNo);
      expect(seats).toEqual(seats.toSorted());
    });

    it('adds a Super Admin by email: Pending, the free seat, welcomed, audited, and then the limit', async () => {
      const address = email();
      const res = await api('post', '/v1/platform/super-admins', admin, {
        email: address,
        firstName: 'Meena',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        email: address,
        displayName: 'Meena',
        accountStatus: 1,
        seatNo: 3,
        authenticatorSetUp: false,
        version: 1,
      });
      expect(await accountStatus(res.body.data.id)).toBe(3);
      await t.app.get(OtpService).flush();
      expect(t.email.latest(address, 'welcome')!.text).toContain('as a Super Admin on');
      const audit = await auditOf('super_admin.add', res.body.data.id);
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toContain(address);

      const fourth = await api('post', '/v1/platform/super-admins', admin, {
        email: candidate.email,
      });
      expect(fourth.status).toBe(409);
      expect(fourth.body.code).toBe('SEAT_LIMIT_REACHED');
      const again = await api('post', '/v1/platform/super-admins', admin, { email: address });
      expect(again.body.code).toBe('DUPLICATE');
    });

    it('validates the body', async () => {
      for (const body of [{}, { email: 'nope' }, { email: email(), extra: 1 }]) {
        expect((await api('post', '/v1/platform/super-admins', admin, body)).status).toBe(400);
      }
    });
  });

  describe('PLT-14 remove a Super Admin', () => {
    it('removes the grant and ends their console sessions, and the seat is free again', async () => {
      const added = await newAdmin();
      expect((await api('get', '/v1/platform/super-admins', added.token)).status).toBe(200);
      const res = await api('delete', `/v1/platform/super-admins/${added.id}`, admin);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: added.id, status: 0 });

      const after = await api('get', '/v1/platform/super-admins', added.token);
      expect(after.status).toBe(401);
      expect(after.body.data).toMatchObject({ reason: 'admin_revoked' });
      expect((await auditOf('super_admin.remove', added.id))[0]!.new_values).toEqual({
        sessions_ended: 1,
      });
      const next = await api('post', '/v1/platform/super-admins', admin, { email: email() });
      expect(next.body.data.seatNo).toBe(3);
    });

    it('never removes yourself, so one Super Admin always remains', async () => {
      const res = await api('delete', `/v1/platform/super-admins/${superAdmin.id}`, admin);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CANNOT_ACT_ON_SELF');
    });

    it('answers 404 for a person who is not a Super Admin, and for an unknown or malformed ID', async () => {
      const owner = await newOwner();
      for (const id of [owner.id, missing, 'not-an-id']) {
        expect((await api('delete', `/v1/platform/super-admins/${id}`, admin)).status).toBe(404);
      }
    });

    it('lets only one of two Super Admins remove the other when both try at once', async () => {
      const added = await newAdmin();
      const results = await Promise.all([
        api('delete', `/v1/platform/super-admins/${added.id}`, admin),
        api('delete', `/v1/platform/super-admins/${superAdmin.id}`, added.token),
      ]);
      const statuses = results.map((result) => result.status).toSorted();
      expect(statuses[0]).toBe(200);
      expect([401, 403]).toContain(statuses[1]);
      const remaining = await sql<{ n: number }>`
        select count(*)::int as n from role_assignments where role_code = 1 and revoked_at is null`.execute(
        ownerDb,
      );
      expect(remaining.rows[0]!.n).toBeGreaterThanOrEqual(2);
      // The seeded Super Admin may be the one that lost: give the seat back.
      await sql`update role_assignments set revoked_at = null, revoked_by = null, revoke_reason = null
        where user_id = ${superAdmin.id} and role_code = 1`.execute(ownerDb);
    });
  });

  describe('PLT-15 and PLT-16 block and unblock', () => {
    it('blocks a whole account: every session ends as blocked, the person is told, and it is audited', async () => {
      const owner = await newOwner();
      const res = await api('post', `/v1/platform/users/${owner.id}/block`, admin, {
        reason: 'Left the Society',
        version: await versionOf(owner.id),
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: owner.id,
        accountStatus: 2,
        blockReason: 'Left the Society',
        blockedAt: expect.any(String),
      });
      const after = await api('get', '/v1/me', owner.token);
      expect(after.status).toBe(401);
      expect(after.body.data).toMatchObject({ reason: 'blocked' });
      await t.app.get(OtpService).flush();
      expect(t.email.latest(owner.email, 'account-blocked')).toBeDefined();
      const audit = (await auditOf('account.block', owner.id))[0]!;
      expect(audit.reason).toBe('Left the Society');
      expect(audit.actor_user_id).toBe(superAdmin.id);
    });

    it('answers a stale version with the current one, refuses a second block, yourself, and a bad body', async () => {
      const owner = await newOwner();
      const version = await versionOf(owner.id);
      const stale = await api('post', `/v1/platform/users/${owner.id}/block`, admin, {
        reason: 'x',
        version: version + 5,
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        data: { currentVersion: version },
      });

      const first = await api('post', `/v1/platform/users/${owner.id}/block`, admin, {
        reason: 'x',
        version,
      });
      expect(first.status).toBe(200);
      const second = await api('post', `/v1/platform/users/${owner.id}/block`, admin, {
        reason: 'x',
        version: first.body.data.version,
      });
      expect(second.body.code).toBe('INVALID_STATE');

      const self = await api('post', `/v1/platform/users/${superAdmin.id}/block`, admin, {
        reason: 'x',
        version: await versionOf(superAdmin.id),
      });
      expect(self.status).toBe(409);
      expect(self.body.code).toBe('CANNOT_ACT_ON_SELF');
      for (const body of [{}, { version }, { reason: 'x' }, { reason: '', version }]) {
        expect(
          (await api('post', `/v1/platform/users/${owner.id}/block`, admin, body)).status,
        ).toBe(400);
      }
      expect(
        (
          await api('post', `/v1/platform/users/${missing}/block`, admin, {
            reason: 'x',
            version: 1,
          })
        ).status,
      ).toBe(404);
    });

    it('unblocks: a person who never signed in is Pending again, the rest Active; an account not blocked is refused', async () => {
      const owner = await newOwner();
      const read = () => versionOf(owner.id);
      expect(
        (
          await api('post', `/v1/platform/users/${owner.id}/unblock`, admin, {
            version: await read(),
          })
        ).body.code,
      ).toBe('INVALID_STATE');
      const blocked = await api('post', `/v1/platform/users/${owner.id}/block`, admin, {
        reason: 'x',
        version: await read(),
      });
      const res = await api('post', `/v1/platform/users/${owner.id}/unblock`, admin, {
        version: blocked.body.data.version,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ accountStatus: 1, blockedAt: null, blockReason: null });
      expect(await accountStatus(owner.id)).toBe(1);
      expect(await auditOf('account.unblock', owner.id)).toHaveLength(1);

      const never = email();
      await sql`insert into users (email, account_status, blocked_at, block_reason) values (${never}, 2, now(), 'x')`.execute(
        ownerDb,
      );
      const neverRow = (
        await sql<{
          id: string;
          version: number;
        }>`select id, version from users where email = ${never}`.execute(ownerDb)
      ).rows[0]!;
      await api('post', `/v1/platform/users/${neverRow.id}/unblock`, admin, {
        version: neverRow.version,
      });
      expect(await accountStatus(neverRow.id)).toBe(3);
    });
  });

  describe('PLT-17 change an email', () => {
    it('changes an Owner’s email at once: sessions end, both addresses are told, and the new one signs in', async () => {
      const owner = await newOwner();
      const version = await versionOf(owner.id);
      const fresh = email();
      const res = await api('put', `/v1/platform/users/${owner.id}/email`, admin, {
        email: fresh.toUpperCase(),
        version,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: owner.id, email: fresh });
      const after = await api('get', '/v1/me', owner.token);
      expect(after.status).toBe(401);
      expect(after.body.data).toMatchObject({ reason: 'email_changed' });
      await t.app.get(OtpService).flush();
      expect(t.email.latest(owner.email, 'email-changed-old')).toBeDefined();
      expect(t.email.latest(fresh, 'email-changed-new')).toBeDefined();
      const login = await signInMobile(t, fresh);
      expect(login.contexts).toHaveLength(1);
      const audit = (await auditOf('account.email_change', owner.id))[0]!;
      expect(JSON.stringify(audit)).not.toContain(fresh);
      expect(JSON.stringify(audit)).not.toContain(owner.email);
    });

    it('also changes a Super Admin’s, and ends their open authenticator step', async () => {
      const added = await newAdmin();
      const hasher = t.app.get(OtpHasher);
      await sql`insert into mfa_challenges (user_id, token_hmac, expires_at)
        values (${added.id}, ${hasher.email('token-' + added.id)}, now() + interval '5 minutes')`.execute(
        ownerDb,
      );
      const res = await api('put', `/v1/platform/users/${added.id}/email`, admin, {
        email: email(),
        version: 1,
      });
      expect(res.status).toBe(200);
      const { rows } = await sql<{
        used_at: Date | null;
      }>`select used_at from mfa_challenges where user_id = ${added.id}`.execute(ownerDb);
      expect(rows[0]!.used_at).not.toBeNull();
      expect((await api('get', '/v1/platform/super-admins', added.token)).body.data).toMatchObject({
        reason: 'email_changed',
      });
    });

    it('refuses an email of another person, a person with no such role, yourself, and a stale version', async () => {
      const owner = await newOwner();
      const version = await versionOf(owner.id);
      const taken = await api('put', `/v1/platform/users/${owner.id}/email`, admin, {
        email: otherAdmin.email,
        version,
      });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('EMAIL_IN_USE');

      const plain = email();
      await sql`insert into users (email) values (${plain})`.execute(ownerDb);
      const plainRow = (
        await sql<{ id: string }>`select id from users where email = ${plain}`.execute(ownerDb)
      ).rows[0]!;
      expect(
        (
          await api('put', `/v1/platform/users/${plainRow.id}/email`, admin, {
            email: email(),
            version: 1,
          })
        ).status,
      ).toBe(404);

      expect(
        (
          await api('put', `/v1/platform/users/${superAdmin.id}/email`, admin, {
            email: email(),
            version: await versionOf(superAdmin.id),
          })
        ).body.code,
      ).toBe('CANNOT_ACT_ON_SELF');
      const stale = await api('put', `/v1/platform/users/${owner.id}/email`, admin, {
        email: email(),
        version: version + 3,
      });
      expect(stale.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        data: { currentVersion: version },
      });
      expect(
        (
          await api('put', `/v1/platform/users/${owner.id}/email`, admin, {
            email: 'nope',
            version,
          })
        ).status,
      ).toBe(400);
    });

    it('writes nothing when the email is the same', async () => {
      const owner = await newOwner();
      const version = await versionOf(owner.id);
      const res = await api('put', `/v1/platform/users/${owner.id}/email`, admin, {
        email: owner.email,
        version,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(version);
      expect((await api('get', '/v1/me', owner.token)).status).toBe(200);
      expect(await auditOf('account.email_change', owner.id)).toHaveLength(0);
    });
  });

  describe('PLT-18 reset an authenticator', () => {
    it('removes it, ends the person’s sessions, tells them and audits it', async () => {
      const added = await newAdmin();
      await giveAuthenticator(added.id);
      const listed = await api('get', '/v1/platform/super-admins', admin);
      expect(
        (listed.body.data as unknown as { id: string; authenticatorSetUp: boolean }[]).find(
          (row) => row.id === added.id,
        )!.authenticatorSetUp,
      ).toBe(true);

      const res = await api('delete', `/v1/platform/users/${added.id}/mfa`, admin);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: added.id, authenticatorSetUp: false });
      const { rows } =
        await sql`select 1 from user_totp_factors where user_id = ${added.id}`.execute(ownerDb);
      expect(rows).toHaveLength(0);
      expect((await api('get', '/v1/platform/super-admins', added.token)).status).toBe(401);
      await t.app.get(OtpService).flush();
      expect(t.email.latest(added.email, 'authenticator-reset')).toBeDefined();
      expect(await auditOf('mfa.reset', added.id)).toHaveLength(1);
    });

    it('is refused while the authenticator is locked, and works after the support unlock', async () => {
      const added = await newAdmin();
      const until = new Date(t.clock.now().getTime() + 3_600_000).toISOString();
      await giveAuthenticator(added.id, until);
      const refused = await api('delete', `/v1/platform/users/${added.id}/mfa`, admin);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('AUTHENTICATOR_LOCKED');
      expect(refused.body.data).toMatchObject({ lockedUntil: expect.any(String) });
      const still = await sql`select 1 from user_totp_factors where user_id = ${added.id}`.execute(
        ownerDb,
      );
      expect(still.rows).toHaveLength(1);

      const unlocked = await api('post', `/v1/platform/users/${added.id}/unlock`, admin, {
        reason: 'Verified by phone',
      });
      expect(unlocked.body.data).toEqual({
        id: added.id,
        loginLockCleared: false,
        authenticatorLockCleared: true,
      });
      expect((await api('delete', `/v1/platform/users/${added.id}/mfa`, admin)).status).toBe(200);
    });

    it('refuses yourself, a person with no authenticator, and a person who is not a Super Admin', async () => {
      expect(
        (await api('delete', `/v1/platform/users/${superAdmin.id}/mfa`, admin)).body.code,
      ).toBe('CANNOT_ACT_ON_SELF');
      const added = await newAdmin();
      expect((await api('delete', `/v1/platform/users/${added.id}/mfa`, admin)).body.code).toBe(
        'MFA_NOT_ENROLLED',
      );
      const owner = await newOwner();
      expect((await api('delete', `/v1/platform/users/${owner.id}/mfa`, admin)).status).toBe(404);
      expect((await api('delete', `/v1/platform/users/${missing}/mfa`, admin)).status).toBe(404);
    });
  });

  describe('PLT-41 support unlock', () => {
    it('lifts a locked email: the person can ask for a code again, and it is audited with the reason', async () => {
      const owner = await newOwner();
      await lockEmail(owner.email);
      expect((await askForCode(owner.email)).status).toBe(423);

      const res = await api('post', `/v1/platform/users/${owner.id}/unlock`, admin, {
        reason: 'Rang the office',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        id: owner.id,
        loginLockCleared: true,
        authenticatorLockCleared: false,
      });
      expect((await askForCode(owner.email)).status).toBe(202);
      const audit = (await auditOf('account.unlock', owner.id))[0]!;
      expect(audit.reason).toBe('Rang the office');
      expect(audit.new_values).toEqual({
        login_lock_cleared: true,
        authenticator_lock_cleared: false,
      });
      const kept =
        await sql`select 1 from login_lockouts where email_hmac = ${t.app.get(OtpHasher).email(owner.email)}`.execute(
          ownerDb,
        );
      expect(kept.rows).toHaveLength(1);
    });

    it('lifts both locks at once, and refuses when nothing is locked or the reason is missing', async () => {
      const added = await newAdmin();
      const until = new Date(t.clock.now().getTime() + 3_600_000).toISOString();
      await giveAuthenticator(added.id, until);
      await lockEmail(added.email);
      const res = await api('post', `/v1/platform/users/${added.id}/unlock`, admin, {
        reason: 'Verified',
      });
      expect(res.body.data).toEqual({
        id: added.id,
        loginLockCleared: true,
        authenticatorLockCleared: true,
      });

      const again = await api('post', `/v1/platform/users/${added.id}/unlock`, admin, {
        reason: 'Verified',
      });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('NOT_LOCKED');
      expect((await api('post', `/v1/platform/users/${added.id}/unlock`, admin, {})).status).toBe(
        400,
      );
      expect(
        (await api('post', `/v1/platform/users/${missing}/unlock`, admin, { reason: 'x' })).status,
      ).toBe(404);
    });
  });
});
