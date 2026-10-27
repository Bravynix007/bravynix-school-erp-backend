import { Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { TokenService } from '../../src/platform/identity/token.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { institutions, personaByKey, societies } from '../../src/seeds/two-worlds.js';
import { FixtureModule } from '../support/fixture.module.js';
import { readAuditRows } from '../support/audit-rows.js';
import { clearLoginState } from '../support/login-state.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

const owner = personaByKey('SO-A1');
const admin = personaByKey('IA-A12');
const parent = personaByKey('P-A1-one');
const superAdmin = personaByKey('SA1');
const societyA = societies.find((s) => s.key === 'A')!;
const societyB = societies.find((s) => s.key === 'B')!;
const institutionB = institutions.find((i) => i.key === 'B1')!;

describe('AUTH-06 switch context and ME-01', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  const signIn = (email: string) => signInMobile(t, email);
  let otp: OtpService;

  const rows = async <T = Record<string, unknown>>(query: RawBuilder<unknown>): Promise<T[]> =>
    (await query.execute(ownerDb)).rows as T[];
  const call = (method: 'get' | 'post', path: string, token: string, body: object = {}) =>
    request(t.app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`).send(body);
  const me = (token: string) => call('get', '/v1/me', token);
  const switchTo = (token: string, body: Record<string, unknown>) =>
    call('post', '/v1/auth/context', token, body);

  /** Gives the owner a second context: Institution Admin in Society B. */
  const grantSecondContext = () =>
    sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
      values (${owner.id}, 3, ${societyB.id}, ${institutionB.id}, gen_random_uuid())`.execute(
      ownerDb,
    );

  const auditRows = <T>(where: RawBuilder<unknown>) => readAuditRows<T>(ownerDb, where);

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
  });

  afterAll(async () => {
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    await sql`delete from role_assignments where user_id in (${owner.id}, ${admin.id}) and role_code = 3`.execute(
      ownerDb,
    );
    await sql`update users set locked_until = null, failed_login_count = 0`.execute(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    otp = t.app.get(OtpService);
  });

  afterEach(async () => {
    await otp.flush();
    await t.close();
  });

  describe('contexts at login and in /me', () => {
    it('lists two contexts and leaves the choice to the person', async () => {
      await grantSecondContext();
      const login = await signIn(owner.email);
      expect(login.session.activeContext).toBeNull();
      expect(login.userType).toBeNull();
      expect(login.contexts).toEqual([
        { roleCode: 2, societyId: societyA.id, societyName: societyA.name, isBlocked: false },
        { roleCode: 3, societyId: societyB.id, societyName: societyB.name, isBlocked: false },
      ]);

      const res = await me(login.accessToken).expect(200);
      expect(res.body.data).toMatchObject({
        userType: null,
        userTypeName: null,
        session: { id: login.session.id, activeContext: null },
        person: { id: owner.id, email: owner.email, accountStatus: 1 },
        contexts: login.contexts,
        requiredNotices: [],
      });
    });

    it('names each Society, so two Owner seats are told apart', async () => {
      await sql`insert into role_assignments (user_id, role_code, society_id, seat_no, created_by)
        values (${owner.id}, 2, ${societyB.id}, 3, ${owner.id})`.execute(ownerDb);
      try {
        const login = await signIn(owner.email);
        expect(login.contexts.map((c) => c.societyName)).toEqual([societyA.name, societyB.name]);
        const res = await switchTo(login.accessToken, { roleCode: 2, societyId: societyB.id });
        expect(res.body.data.activeContext).toMatchObject({ societyName: societyB.name });
      } finally {
        await sql`delete from role_assignments where user_id = ${owner.id} and society_id = ${societyB.id} and role_code = 2`.execute(
          ownerDb,
        );
      }
    });

    it('reads a Society name only through a function the public cannot call', async () => {
      const [fn] = await rows<{ owner_only: boolean; app_can: boolean }>(
        sql`select proacl::text !~ '(^|[{,])=' as owner_only,
          has_function_privilege('erp_app', 'app_society_name(uuid)', 'execute') as app_can
          from pg_proc where proname = 'app_society_name'`,
      );
      expect(fn).toEqual({ owner_only: true, app_can: true });
    });

    it('puts the caller’s role setting back after reading a Society name', async () => {
      const seen = await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '2', true)`.execute(tx);
        const name = await sql<{ name: string | null }>`
          select app_society_name(${societyA.id}::uuid) as name`.execute(tx);
        const role = await sql<{
          role: string;
        }>`select current_setting('app.role_code') as role`.execute(tx);
        return { name: name.rows[0]?.name, role: role.rows[0]?.role };
      });
      expect(seen).toEqual({ name: societyA.name, role: '2' });
    });

    it('is one context for an Institution Admin of two Institutions in one Society', async () => {
      for (const key of ['A1', 'A2']) {
        const institution = institutions.find((i) => i.key === key)!;
        await sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
          values (${admin.id}, 3, ${societyA.id}, ${institution.id}, gen_random_uuid())`.execute(
          ownerDb,
        );
      }
      const login = await signIn(admin.email);
      const expected = {
        roleCode: 3,
        societyId: societyA.id,
        societyName: societyA.name,
        isBlocked: false,
      };
      expect(login.contexts).toEqual([expected]);
      expect(login.session.activeContext).toEqual(expected);
    });

    it('answers /me for a person with no context, and for a Super Admin on the console', async () => {
      const login = await signIn(parent.email);
      const res = await me(login.accessToken).expect(200);
      expect(res.body.data).toMatchObject({ contexts: [], session: { activeContext: null } });

      const [created] = await rows<{ id: string }>(
        sql`insert into auth_sessions (user_id, client_type, idle_expires_at, absolute_expires_at)
            values (${superAdmin.id}, 2, now() + interval '1 hour', now() + interval '1 hour') returning id`,
      );
      const signed = await t.app.get(TokenService).signAccessToken(
        {
          personId: superAdmin.id,
          sessionId: created!.id,
          roleCode: 1,
          societyId: null,
          clientType: 'console',
        },
        t.clock.now(),
      );
      await sql`update auth_sessions set active_role_code = 1 where id = ${created!.id}`.execute(
        ownerDb,
      );
      const admin1 = await me(signed.token).expect(200);
      expect(admin1.body.data).toMatchObject({
        userType: 1,
        userTypeName: 'super_admin',
        contexts: [{ roleCode: 1, societyId: null }],
      });
      // The console has one context; switching is for the mobile app.
      await switchTo(signed.token, { roleCode: 2, societyId: societyA.id }).expect(403);
    });

    it('needs a signed-in session', async () => {
      await request(t.app.getHttpServer()).get('/v1/me').expect(401);
    });
  });

  describe('switching', () => {
    it('moves the session to the chosen context and returns a token for it', async () => {
      await grantSecondContext();
      const login = await signIn(owner.email);
      const res = await switchTo(login.accessToken, { roleCode: 3, societyId: societyB.id }).expect(
        200,
      );
      expect(res.body).toMatchObject({
        success: true,
        code: 'CONTEXT_SWITCHED',
        data: {
          userType: 3,
          userTypeName: 'institution_admin',
          activeContext: {
            roleCode: 3,
            societyId: societyB.id,
            societyName: societyB.name,
            isBlocked: false,
          },
        },
      });
      const claims = await t.app
        .get(TokenService)
        .checkAccessToken(res.body.data.accessToken, t.clock.now());
      expect(claims).toMatchObject({
        status: 'valid',
        claims: { roleCode: 3, societyId: societyB.id },
      });

      const [session] = await rows<{ active_role_code: number; active_society_id: string }>(
        sql`select active_role_code, active_society_id from auth_sessions where id = ${login.session.id}`,
      );
      expect(session).toEqual({ active_role_code: 3, active_society_id: societyB.id });
      const now = await me(res.body.data.accessToken).expect(200);
      expect(now.body.data).toMatchObject({
        userType: 3,
        session: {
          activeContext: { roleCode: 3, societyId: societyB.id, societyName: societyB.name },
        },
      });
    });

    it('takes the role from the session, so an older token cannot keep acting as the old role', async () => {
      await grantSecondContext();
      const login = await signIn(owner.email);
      const asOwner = await switchTo(login.accessToken, {
        roleCode: 2,
        societyId: societyA.id,
      }).expect(200);
      await call('post', '/v1/fixtures/owner-write', asOwner.body.data.accessToken).expect(200);
      await switchTo(asOwner.body.data.accessToken, { roleCode: 3, societyId: societyB.id }).expect(
        200,
      );
      // The owner-role token is still signed and unexpired, but the session now acts as role 3.
      await call('post', '/v1/fixtures/owner-write', asOwner.body.data.accessToken).expect(403);
    });

    it('keeps the chosen context when the session is renewed', async () => {
      await grantSecondContext();
      const login = await signIn(owner.email);
      await switchTo(login.accessToken, { roleCode: 3, societyId: societyB.id }).expect(200);
      const renewed = await request(t.app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken: login.refreshToken })
        .expect(200);
      const claims = await t.app
        .get(TokenService)
        .checkAccessToken(renewed.body.data.accessToken, t.clock.now());
      expect(claims).toMatchObject({ claims: { roleCode: 3, societyId: societyB.id } });
    });

    it('audits the switch with the old and the new context', async () => {
      await grantSecondContext();
      const login = await signIn(owner.email);
      const first = await switchTo(login.accessToken, {
        roleCode: 2,
        societyId: societyA.id,
      }).expect(200);
      const second = await switchTo(first.body.data.accessToken, {
        roleCode: 3,
        societyId: societyB.id,
      }).expect(200);
      const entries = await auditRows<{
        old_values: unknown;
        new_values: unknown;
        entity_id: string;
      }>(sql`action = 'auth.context_switch' and request_id = ${second.body.requestId}`);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        entity_id: owner.id,
        old_values: { roleCode: 2, societyId: societyA.id },
        new_values: { roleCode: 3, societyId: societyB.id },
      });
    });

    it('refuses a role the person does not hold, in that Society or at all', async () => {
      const login = await signIn(owner.email);
      for (const body of [
        { roleCode: 3, societyId: societyA.id },
        { roleCode: 2, societyId: societyB.id },
        { roleCode: 4, societyId: societyA.id },
        { roleCode: 5 },
      ]) {
        const res = await switchTo(login.accessToken, body).expect(403);
        expect(res.body).toMatchObject({ success: false, code: 'CONTEXT_NOT_AVAILABLE' });
      }
      const [session] = await rows<{ active_role_code: number }>(
        sql`select active_role_code from auth_sessions where id = ${login.session.id}`,
      );
      expect(session!.active_role_code).toBe(2);
    });

    it('lets a person with no context try, and refuses them', async () => {
      const login = await signIn(parent.email);
      const res = await switchTo(login.accessToken, { roleCode: 5 }).expect(403);
      expect(res.body.code).toBe('CONTEXT_NOT_AVAILABLE');
    });

    it('validates the body', async () => {
      const login = await signIn(owner.email);
      const errors = async (body: Record<string, unknown>) =>
        (await switchTo(login.accessToken, body).expect(400)).body.errors[0];
      expect(await errors({ roleCode: 1, societyId: societyA.id })).toMatchObject({
        field: 'roleCode',
        code: 'INVALID_CODE',
      });
      expect(await errors({ roleCode: '2', societyId: societyA.id })).toMatchObject({
        field: 'roleCode',
        code: 'INVALID_TYPE',
      });
      expect(await errors({ societyId: societyA.id })).toMatchObject({ field: 'roleCode' });
      expect(await errors({ roleCode: 2 })).toMatchObject({ field: 'societyId', code: 'REQUIRED' });
      expect(await errors({ roleCode: 2, societyId: 'nope' })).toMatchObject({
        field: 'societyId',
        code: 'INVALID_FORMAT',
      });
      expect(await errors({ roleCode: 5, societyId: societyA.id })).toMatchObject({
        field: 'societyId',
        code: 'FIELD_NOT_ALLOWED',
      });
      expect(await errors({ roleCode: 2, societyId: societyA.id, extra: 1 })).toMatchObject({
        code: 'FIELD_NOT_ALLOWED',
      });
    });
  });
});
