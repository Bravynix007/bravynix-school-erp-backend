import { Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { newId } from '../../src/common/ids/ids.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { dumpTables, readAuditRows } from '../support/audit-rows.js';
import { Authenticator, signInConsole, startConsoleSignIn } from '../support/console-session.js';
import { clearLoginState } from '../support/login-state.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const CONSOLE = { 'X-Requested-With': 'bravynix-console' };

/** The `name=value` part of a `Set-Cookie` line, as a browser sends it back. */
const cookieHeader = (setCookie: string) => setCookie.split(';')[0]!;

describe('AUTH-03 and AUTH-04: the Super Admin authenticator', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let otp: OtpService;
  let auditFloor: string;

  const http = () => t.app.getHttpServer();
  const post = (path: string, body: object = {}) => request(http()).post(path).send(body);
  const enrol = (mfaToken: string) => post('/v1/auth/mfa/enrol', { mfaToken });
  const verify = (mfaToken: string, code: string) =>
    post('/v1/auth/mfa/verify', { mfaToken, code });
  const firstError = async (body: Record<string, unknown>) =>
    (await post('/v1/auth/mfa/verify', body).expect(400)).body.errors[0];
  const refresh = (setCookie: string, headers: Record<string, string> = CONSOLE) =>
    request(http())
      .post('/v1/auth/refresh')
      .set(headers)
      .set('Cookie', cookieHeader(setCookie))
      .send({});
  /** Five wrong codes on a new token, whichever way the answers go. */
  async function wrongCodes(app: Authenticator, tries: number) {
    const started = await startConsoleSignIn(t, superAdmin.email);
    const answers = [];
    for (let i = 0; i < tries; i += 1) answers.push(await verify(started.mfaToken, wrongFor(app)));
    // Past the per-email limit on code requests (3 in 15 minutes), so the next sign-in is not refused.
    t.clock.advanceMinutes(16);
    return answers;
  }
  const factorRow = async () =>
    (
      await rows<{ wrong_codes: number; wrong_since: Date | null; locked_until: Date | null }>(
        sql`select wrong_codes, wrong_since, locked_until from user_totp_factors`,
      )
    )[0]!;
  const rows = async <T = Record<string, unknown>>(query: RawBuilder<unknown>): Promise<T[]> =>
    (await query.execute(ownerDb)).rows as T[];
  /** Audit rows written during this test only: the log is append-only, and IDs are time-ordered. */
  const auditRows = <T>(where: RawBuilder<unknown>) =>
    readAuditRows<T>(ownerDb, sql`id > ${auditFloor}::uuid and ${where}`);
  const wrongFor = (app: Authenticator) => {
    const right = app.code(t.clock.now());
    return right === '000000' ? '000001' : '000000';
  };

  /** Blocks or restores the Super Admin; a blocked account carries the time it was blocked (DDD 9.1). */
  const setStatus = (status: 1 | 2) =>
    sql`update users set account_status = ${status},
      blocked_at = ${status === 2 ? sql`now()` : null} where id = ${superAdmin.id}`.execute(
      ownerDb,
    );

  /** Starts a sign-in and enrols an authenticator, without confirming it. */
  async function enrolled() {
    const started = await startConsoleSignIn(t, superAdmin.email);
    const res = await enrol(started.mfaToken).expect(200);
    return { started, app: new Authenticator(res.body.data.secret as string), body: res.body };
  }

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
    await sql`update users set locked_until = null, failed_login_count = 0`.execute(ownerDb);
    await sql`update role_assignments set revoked_at = null where user_id = ${superAdmin.id} and role_code = 1`.execute(
      ownerDb,
    );
    await setStatus(1);
    auditFloor = newId();
    t = await createTestApp({ captureLogs: true });
    otp = t.app.get(OtpService);
  });

  afterEach(async () => {
    await otp.flush();
    await t.close();
  });

  describe('after the email code', () => {
    it('answers MFA_REQUIRED with a 5-minute token, no tokens, no session, and spends the code', async () => {
      const started = await startConsoleSignIn(t, superAdmin.email);
      expect(started).toEqual({
        mfaRequired: true,
        mfaToken: expect.stringMatching(/^mfa_[\w-]{43}$/),
        mfaEnrolled: false,
      });
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${superAdmin.id}`),
      ).toHaveLength(0);
      expect(await rows(sql`select 1 from refresh_tokens`)).toHaveLength(0);
      const [challenge] = await rows<{ consumed_at: Date | null }>(
        sql`select consumed_at from otp_challenges where user_id = ${superAdmin.id}`,
      );
      expect(challenge!.consumed_at).not.toBeNull();

      const [stored] = await rows<{ token_hmac: Buffer; lifetime: number }>(
        sql`select token_hmac, extract(epoch from expires_at - created_at)::int as lifetime from mfa_challenges`,
      );
      expect(stored!.lifetime).toBe(300);
      expect(stored!.token_hmac.toString('utf8')).not.toContain(started.mfaToken);
    });

    it('keeps one open token per person: a new sign-in replaces the earlier one', async () => {
      const first = await startConsoleSignIn(t, superAdmin.email);
      const second = await startConsoleSignIn(t, superAdmin.email);
      const res = await enrol(first.mfaToken).expect(401);
      expect(res.body.code).toBe('MFA_TOKEN_EXPIRED');
      await enrol(second.mfaToken).expect(200);
    });
  });

  describe('AUTH-03 enrol', () => {
    it('returns a setup link and secret, and keeps only an encrypted copy', async () => {
      const { body, app } = await enrolled();
      expect(body).toMatchObject({ success: true, code: 'MFA_SETUP_STARTED' });
      expect(body.data.setupUri).toMatch(
        new RegExp(`^otpauth://totp/BravyNix%20School%20ERP:.+secret=${body.data.secret}`),
      );
      expect(body.data.setupUri).toContain('issuer=BravyNix+School+ERP');
      expect(app.code(t.clock.now())).toMatch(/^\d{6}$/);

      const [factor] = await rows<{
        secret_ciphertext: Buffer;
        secret_key_version: number;
        confirmed_at: Date | null;
      }>(sql`select secret_ciphertext, secret_key_version, confirmed_at from user_totp_factors`);
      expect(factor).toMatchObject({ secret_key_version: 1, confirmed_at: null });
      // Neither the raw bytes nor the base32 text appear in what is stored.
      expect(factor!.secret_ciphertext.includes(app.secret)).toBe(false);
      expect(factor!.secret_ciphertext.toString('latin1')).not.toContain(body.data.secret);
      const entries = await auditRows<{ entity_id: string }>(
        sql`action = 'auth.mfa_enrol_started'`,
      );
      expect(entries.map((e) => e.entity_id)).toEqual([superAdmin.id]);
    });

    it('starts again with a new secret until the first code is confirmed', async () => {
      const { started, app: old } = await enrolled();
      const again = await enrol(started.mfaToken).expect(200);
      const fresh = new Authenticator(again.body.data.secret as string);
      const attempt = await verify(started.mfaToken, old.code(t.clock.now())).expect(401);
      expect(attempt.body.code).toBe('MFA_INVALID');
      await verify(started.mfaToken, fresh.code(t.clock.now())).expect(200);
    });

    it('refuses once an authenticator is confirmed', async () => {
      const { authenticator } = await signInConsole(t, superAdmin.email);
      const again = await startConsoleSignIn(t, superAdmin.email);
      expect(again.mfaEnrolled).toBe(true);
      const res = await enrol(again.mfaToken).expect(409);
      expect(res.body.code).toBe('MFA_ALREADY_ENROLLED');
      // The refusal left the token and the secret as they were.
      await verify(again.mfaToken, authenticator.code(t.clock.now())).expect(200);
    });

    it('needs a good token and a body of the right shape', async () => {
      expect((await enrol('mfa_nothing').expect(401)).body.code).toBe('MFA_TOKEN_EXPIRED');
      expect((await enrol('x'.repeat(100)).expect(401)).body.code).toBe('MFA_TOKEN_EXPIRED');
      const missing = await post('/v1/auth/mfa/enrol', {}).expect(400);
      expect(missing.body.errors[0]).toMatchObject({ field: 'mfaToken', code: 'REQUIRED' });
      const typed = await post('/v1/auth/mfa/enrol', { mfaToken: 5 }).expect(400);
      expect(typed.body.errors[0]).toMatchObject({ field: 'mfaToken', code: 'INVALID_TYPE' });
    });
  });

  describe('AUTH-04 verify', () => {
    it('confirms the authenticator and starts a 12-hour console session with the cookie', async () => {
      const { started, app } = await enrolled();
      const res = await verify(started.mfaToken, app.code(t.clock.now())).expect(200);
      expect(res.body).toMatchObject({
        success: true,
        code: 'LOGIN_OK',
        data: {
          userType: 1,
          userTypeName: 'super_admin',
          refreshToken: null,
          session: { activeContext: { roleCode: 1, societyId: null } },
          person: { id: superAdmin.id, email: superAdmin.email },
          contexts: [{ roleCode: 1, societyId: null }],
          requiredNotices: [],
        },
      });
      expect(JSON.stringify(res.body)).not.toContain('rt_');

      const [cookie] = res.headers['set-cookie'] as unknown as string[];
      expect(cookie).toMatch(/^bnx_refresh=rt_[\w-]{43};/);
      expect(cookie).toMatch(/Path=\/v1\/auth;/);
      expect(cookie).toMatch(/Max-Age=43200;/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');

      const [session] = await rows<{
        client_type: number;
        active_role_code: number;
        active_society_id: string | null;
        idle_seconds: number;
        absolute_seconds: number;
      }>(
        sql`select client_type, active_role_code, active_society_id,
          extract(epoch from idle_expires_at - created_at)::int as idle_seconds,
          extract(epoch from absolute_expires_at - created_at)::int as absolute_seconds
          from auth_sessions where user_id = ${superAdmin.id}`,
      );
      expect(session).toEqual({
        client_type: 2,
        active_role_code: 1,
        active_society_id: null,
        idle_seconds: 43200,
        absolute_seconds: 43200,
      });
      const [factor] = await rows<{ confirmed_at: Date | null; last_used_step: number }>(
        sql`select confirmed_at, last_used_step from user_totp_factors`,
      );
      expect(factor!.confirmed_at).not.toBeNull();
      expect(factor!.last_used_step).toBeGreaterThan(0);

      const me = await request(http())
        .get('/v1/me')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .expect(200);
      expect(me.body.data).toMatchObject({
        userType: 1,
        contexts: [{ roleCode: 1, societyId: null }],
      });

      const audit = await auditRows<{ action: string; new_values: unknown }>(
        sql`action in ('auth.login', 'auth.mfa_enrolled') and entity_id = ${superAdmin.id}`,
      );
      expect(audit.map((e) => e.action).toSorted()).toEqual(['auth.login', 'auth.mfa_enrolled']);
      expect(audit.find((e) => e.action === 'auth.login')!.new_values).toEqual({
        channel: 'console',
      });
    });

    it('stores no token, cookie or secret in the clear, in any table or in the log', async () => {
      const { started, app } = await enrolled();
      const res = await verify(started.mfaToken, app.code(t.clock.now())).expect(200);
      const cookie = cookieHeader((res.headers['set-cookie'] as unknown as string[])[0]!).split(
        '=',
      )[1]!;
      const dump = await dumpTables(ownerDb, [
        'mfa_challenges',
        'user_totp_factors',
        'auth_sessions',
        'refresh_tokens',
        'otp_challenges',
      ]);
      const secretText = Buffer.from(app.secret).toString('base64');
      for (const secret of [
        started.mfaToken,
        started.mfaToken.slice(4),
        cookie,
        res.body.data.accessToken,
        app.secret.toString('hex'),
        secretText,
      ]) {
        expect(dump).not.toContain(secret);
      }
      expect(JSON.stringify(t.logs)).not.toContain(started.mfaToken);
    });

    it('signs in again with the app, and a token works once', async () => {
      const first = await signInConsole(t, superAdmin.email);
      const started = await startConsoleSignIn(t, superAdmin.email);
      expect(started.mfaEnrolled).toBe(true);
      const code = first.authenticator.code(t.clock.now());
      await verify(started.mfaToken, code).expect(200);
      const reused = await verify(
        started.mfaToken,
        first.authenticator.code(t.clock.now(), 1),
      ).expect(401);
      expect(reused.body.code).toBe('MFA_TOKEN_EXPIRED');
      // Only the first confirmation is audited as an enrolment.
      const audit = await auditRows(sql`action = 'auth.mfa_enrolled'`);
      expect(audit).toHaveLength(1);
    });

    it('accepts a code from the step either side of now, and refuses one further away', async () => {
      const { started, app } = await enrolled();
      const far = await verify(started.mfaToken, app.code(t.clock.now(), 2)).expect(401);
      expect(far.body.code).toBe('MFA_INVALID');
      await verify(started.mfaToken, app.code(t.clock.now(), -1)).expect(200);
    });

    it('never accepts a code twice, nor an older one after a newer', async () => {
      const first = await signInConsole(t, superAdmin.email);
      // Same step as the sign-in just made: the code is used up.
      const same = await startConsoleSignIn(t, superAdmin.email);
      const replay = first.authenticator.code(t.clock.now(), -2);
      expect((await verify(same.mfaToken, replay).expect(401)).body.code).toBe('MFA_INVALID');
      // The newest step in the window is accepted; the one before it is then too old.
      await verify(same.mfaToken, first.authenticator.code(t.clock.now(), 1)).expect(200);
      const next = await startConsoleSignIn(t, superAdmin.email);
      const older = first.authenticator.code(t.clock.now(), -1);
      expect((await verify(next.mfaToken, older).expect(401)).body.code).toBe('MFA_INVALID');
    });

    it('lets only one of two sign-ins racing with the same code through', async () => {
      const first = await signInConsole(t, superAdmin.email);
      const a = await startConsoleSignIn(t, superAdmin.email);
      const code = first.authenticator.code(t.clock.now());
      const answers = await Promise.all([verify(a.mfaToken, code), verify(a.mfaToken, code)]);
      expect(answers.map((res) => res.status).toSorted()).toEqual([200, 401]);
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${superAdmin.id}`),
      ).toHaveLength(2);
    });

    it('counts wrong codes, says how many are left, and kills the token at the fifth', async () => {
      const { started, app } = await enrolled();
      for (const attemptsLeft of [4, 3, 2, 1]) {
        const res = await verify(started.mfaToken, wrongFor(app)).expect(401);
        expect(res.body).toMatchObject({ code: 'MFA_INVALID', data: { attemptsLeft } });
      }
      const last = await verify(started.mfaToken, wrongFor(app)).expect(401);
      expect(last.body).toMatchObject({ code: 'MFA_INVALID', data: { attemptsLeft: 0 } });

      // Even the right code is no use now: the token is dead and the console starts again.
      const dead = await verify(started.mfaToken, app.code(t.clock.now())).expect(401);
      expect(dead.body.code).toBe('MFA_TOKEN_EXPIRED');
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${superAdmin.id}`),
      ).toHaveLength(0);

      const audit = await auditRows<{ outcome: number; new_values: unknown }>(
        sql`action = 'auth.mfa_locked'`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 2, new_values: { wrongCodes: 5 } });
    });

    it('does not let the wrong tries of one token touch the next one', async () => {
      const { started, app } = await enrolled();
      for (let i = 0; i < 5; i += 1) await verify(started.mfaToken, wrongFor(app)).expect(401);
      const next = await startConsoleSignIn(t, superAdmin.email);
      const res = await verify(next.mfaToken, wrongFor(app)).expect(401);
      expect(res.body.data.attemptsLeft).toBe(4);
    });

    it('answers MFA_TOKEN_EXPIRED after 5 minutes, and for tokens that never existed', async () => {
      const { started, app } = await enrolled();
      t.clock.advance(301_000);
      const lapsed = await verify(started.mfaToken, app.code(t.clock.now())).expect(401);
      expect(lapsed.body.code).toBe('MFA_TOKEN_EXPIRED');
      expect((await verify('mfa_unknown', '123456').expect(401)).body.code).toBe(
        'MFA_TOKEN_EXPIRED',
      );
      expect(lapsed.body.code).not.toBe('TOKEN_EXPIRED');
    });

    it('asks to set the authenticator up first when there is none', async () => {
      const started = await startConsoleSignIn(t, superAdmin.email);
      const res = await verify(started.mfaToken, '123456').expect(409);
      expect(res.body.code).toBe('MFA_NOT_ENROLLED');
    });

    it('checks the person again: blocked or no longer a Super Admin gets no session', async () => {
      const blocked = await enrolled();
      await setStatus(2);
      const one = await verify(blocked.started.mfaToken, blocked.app.code(t.clock.now())).expect(
        403,
      );
      expect(one.body.code).toBe('ACCOUNT_BLOCKED');
      await setStatus(1);

      t.clock.advance(61_000);
      const revoked = await startConsoleSignIn(t, superAdmin.email);
      await sql`update role_assignments set revoked_at = now() where user_id = ${superAdmin.id} and role_code = 1`.execute(
        ownerDb,
      );
      const two = await verify(revoked.mfaToken, blocked.app.code(t.clock.now())).expect(403);
      expect(two.body.code).toBe('CONSOLE_NOT_ALLOWED');
      const three = await enrol(revoked.mfaToken).expect(401);
      expect(three.body.code).toBe('MFA_TOKEN_EXPIRED');
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${superAdmin.id}`),
      ).toHaveLength(0);
    });

    it('needs a 6-digit code of type string', async () => {
      const { started } = await enrolled();
      expect(await firstError({ mfaToken: started.mfaToken, code: '12345' })).toMatchObject({
        field: 'code',
        code: 'INVALID_FORMAT',
      });
      expect(await firstError({ mfaToken: started.mfaToken, code: 123_456 })).toMatchObject({
        field: 'code',
        code: 'INVALID_TYPE',
      });
      expect(await firstError({ code: '123456' })).toMatchObject({
        field: 'mfaToken',
        code: 'REQUIRED',
      });
      expect(
        await firstError({ mfaToken: started.mfaToken, code: '123456', extra: 1 }),
      ).toMatchObject({
        code: 'FIELD_NOT_ALLOWED',
      });
    });

    it('counts every call toward the per-address limit of 20 a minute', async () => {
      for (let i = 0; i < 20; i += 1) await verify('mfa_unknown', '123456').expect(401);
      const res = await verify('mfa_unknown', '123456').expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
    });
  });

  describe('the per-person cap on wrong codes', () => {
    it('locks the console for 24 hours at the tenth wrong code over two tokens, with a mail and an audit entry', async () => {
      const { authenticator } = await signInConsole(t, superAdmin.email);
      await wrongCodes(authenticator, 5);
      const second = await wrongCodes(authenticator, 5);
      // The tenth wrong code answers with the lock, not with MFA_INVALID.
      expect(second.slice(0, 4).map((res) => res.body.code)).toEqual(Array(4).fill('MFA_INVALID'));
      expect(second[4]!.status).toBe(423);
      expect(second[4]!.body.code).toBe('AUTH_LOCKED');
      expect(second[4]!.headers['retry-after']).toBe('86400');

      const locked = await factorRow();
      expect(locked.locked_until).not.toBeNull();
      expect(locked.wrong_codes).toBe(0);
      await otp.flush();
      expect(t.email.latest(superAdmin.email, 'authenticator-lockout')?.text).toContain('24 hours');
      const entries = await auditRows<{ new_values: unknown; outcome: number }>(
        sql`action = 'auth.mfa_account_locked'`,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        outcome: 2,
        new_values: { wrongCodes: 10, lockSeconds: 86_400 },
      });
    });

    it('stops the sign-in at the email step while locked, even with the right code, and then lets it through', async () => {
      const { authenticator } = await signInConsole(t, superAdmin.email);
      await wrongCodes(authenticator, 5);
      await wrongCodes(authenticator, 5);

      const http2 = request(http());
      await http2.post('/v1/auth/otp').send({ email: superAdmin.email, clientType: 2 }).expect(202);
      await otp.flush();
      const code = t.email.latest(superAdmin.email, 'otp')!.variables!.code as string;
      const res = await post('/v1/auth/otp/verify', {
        email: superAdmin.email,
        code,
        clientType: 2,
      }).expect(423);
      expect(res.body.code).toBe('AUTH_LOCKED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(80_000);
      expect(await rows(sql`select 1 from mfa_challenges where used_at is null`)).toHaveLength(0);

      t.clock.advance(86_400_000 + 61_000);
      const again = await signInConsole(t, superAdmin.email, authenticator);
      expect(again.login.userType).toBe(1);
    });

    it('counts across tokens only within a day, and a right code clears the count', async () => {
      const { authenticator } = await signInConsole(t, superAdmin.email);
      await wrongCodes(authenticator, 5);
      expect((await factorRow()).wrong_codes).toBe(5);
      t.clock.advance(86_400_000 + 1000);
      await wrongCodes(authenticator, 5);
      // The first five were more than a day old, so the count started again at one.
      expect((await factorRow()).wrong_codes).toBe(5);
      expect((await factorRow()).locked_until).toBeNull();

      await signInConsole(t, superAdmin.email, authenticator);
      expect(await factorRow()).toMatchObject({ wrong_codes: 0, wrong_since: null });
    });
  });

  describe('the console session', () => {
    it('renews from the cookie with the console header, rotating it without moving the end', async () => {
      const { cookie, login } = await signInConsole(t, superAdmin.email);
      const [before] = await rows<{ absolute_expires_at: Date }>(
        sql`select absolute_expires_at from auth_sessions where id = ${login.session.id}`,
      );
      t.clock.advance(3600_000);
      const res = await refresh(cookie).expect(200);
      expect(res.body).toMatchObject({ code: 'REFRESH_OK', data: { refreshToken: null } });
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      const [next] = res.headers['set-cookie'] as unknown as string[];
      expect(next).not.toBe(cookie);
      expect(next).toMatch(/Max-Age=39600;/);
      expect(next).toContain('HttpOnly');

      const [after] = await rows<{ absolute_expires_at: Date; idle_expires_at: Date }>(
        sql`select absolute_expires_at, idle_expires_at from auth_sessions where id = ${login.session.id}`,
      );
      expect(after!.absolute_expires_at).toEqual(before!.absolute_expires_at);
      expect(after!.idle_expires_at).toEqual(before!.absolute_expires_at);
      await request(http())
        .get('/v1/me')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .expect(200);
    });

    it('refuses a refresh without the console header or without the cookie', async () => {
      const { cookie } = await signInConsole(t, superAdmin.email);
      const noHeader = await refresh(cookie, {}).expect(403);
      expect(noHeader.body.code).toBe('FORBIDDEN');
      const wrong = await refresh(cookie, { 'X-Requested-With': 'XMLHttpRequest' }).expect(403);
      expect(wrong.body.code).toBe('FORBIDDEN');
      const noCookie = await request(http())
        .post('/v1/auth/refresh')
        .set(CONSOLE)
        .send({})
        .expect(401);
      expect(noCookie.body.code).toBe('REFRESH_TOKEN_INVALID');
      // The refusals used nothing up: the cookie still works.
      await refresh(cookie).expect(200);
    });

    it('does not take the console token from the body, nor a mobile token from the cookie', async () => {
      const { cookie } = await signInConsole(t, superAdmin.email);
      const token = cookieHeader(cookie).split('=')[1]!;
      const body = await post('/v1/auth/refresh', { refreshToken: token }).expect(401);
      expect(body.body.code).toBe('REFRESH_TOKEN_INVALID');
      // The token was not used up by that: the cookie still renews.
      await refresh(cookie).expect(200);
    });

    it('ends the session when a cookie is used twice, and clears the cookie', async () => {
      const { cookie, login } = await signInConsole(t, superAdmin.email);
      await refresh(cookie).expect(200);
      const again = await refresh(cookie).expect(401);
      expect(again.body.code).toBe('REFRESH_TOKEN_REUSED');
      const [cleared] = again.headers['set-cookie'] as unknown as string[];
      expect(cleared).toMatch(/^bnx_refresh=;/);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      const [session] = await rows<{ end_reason: number }>(
        sql`select end_reason from auth_sessions where id = ${login.session.id}`,
      );
      expect(session!.end_reason).toBe(5);
    });

    it('ends at 12 hours however busy it is', async () => {
      const { cookie, login } = await signInConsole(t, superAdmin.email);
      let current = cookie;
      for (let hour = 0; hour < 11; hour += 1) {
        t.clock.advance(3600_000);
        const res = await refresh(current).expect(200);
        [current] = res.headers['set-cookie'] as unknown as string[] as [string];
      }
      t.clock.advance(3600_000 + 1000);
      const late = await refresh(current).expect(401);
      expect(late.body.code).toBe('REFRESH_TOKEN_INVALID');
      const [session] = await rows<{ end_reason: number }>(
        sql`select end_reason from auth_sessions where id = ${login.session.id}`,
      );
      expect(session!.end_reason).toBe(6);
    });

    it('keeps the cookie when the refresh fails for a reason that is not the cookie', async () => {
      const { cookie } = await signInConsole(t, superAdmin.email);
      for (let i = 0; i < 300; i += 1)
        await request(http()).post('/v1/auth/refresh').send({ refreshToken: 'rt_x' });
      const limited = await refresh(cookie).expect(429);
      expect(limited.headers['set-cookie']).toBeUndefined();
    });

    it('logs out only on a call with the console header, and clears the cookie', async () => {
      const { login } = await signInConsole(t, superAdmin.email);
      const auth = { Authorization: `Bearer ${login.accessToken}` };
      const refused = await request(http()).post('/v1/auth/logout').set(auth).send({}).expect(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      await request(http()).get('/v1/me').set(auth).expect(200);

      const res = await request(http())
        .post('/v1/auth/logout')
        .set(auth)
        .set(CONSOLE)
        .send({})
        .expect(200);
      expect(res.body.code).toBe('LOGOUT_OK');
      const [cleared] = res.headers['set-cookie'] as unknown as string[];
      expect(cleared).toMatch(/^bnx_refresh=;/);
      expect(cleared).toContain('Path=/v1/auth');
      const after = await request(http()).get('/v1/me').set(auth).expect(401);
      expect(after.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'logout' } });
    });

    it('ends every session on logout-all, with the same header rule', async () => {
      const first = await signInConsole(t, superAdmin.email);
      const second = await signInConsole(t, superAdmin.email, first.authenticator);
      const auth = { Authorization: `Bearer ${second.login.accessToken}` };
      await request(http()).post('/v1/auth/logout-all').set(auth).send({}).expect(403);
      await request(http()).post('/v1/auth/logout-all').set(auth).set(CONSOLE).send({}).expect(200);
      const gone = await request(http())
        .get('/v1/me')
        .set('Authorization', `Bearer ${first.login.accessToken}`)
        .expect(401);
      expect(gone.body.data.reason).toBe('logout_all');
    });
  });
});
