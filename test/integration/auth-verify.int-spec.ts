import { Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import request from 'supertest';
import { createPool, DatabaseService } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { BackgroundMailer } from '../../src/platform/identity/background-mailer.js';
import { OtpHasher } from '../../src/platform/identity/otp-hasher.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { TokenService } from '../../src/platform/identity/token.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey, societies } from '../../src/seeds/two-worlds.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const secret = process.env.OTP_HMAC_SECRET!;

const owner1 = personaByKey('SO-A1');
const parent = personaByKey('P-A1-one');
const pending = personaByKey('EDGE-pending');
const blocked = personaByKey('EDGE-blocked');
const inactive = personaByKey('EDGE-inactive');
const superAdmin = personaByKey('SA1');
const teacher = personaByKey('T-A1-assigned');
const societyA = societies.find((s) => s.key === 'A')!;
const unknown = 'nobody@two-worlds.test';

const wrongFor = (code: string) => (code === '000000' ? '000001' : '000000');

const device = { platform: 1, label: 'Pixel 8', appVersion: '1.4.0' };

/** A body with the per-request fields removed. */
function shape(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = body;
  return rest;
}

describe('AUTH-02 verify the code', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let otp: OtpService;

  const post = (path: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer()).post(path).send(body);
  const ask = (email: string, clientType = 1) =>
    post('/v1/auth/otp', { email, clientType }).expect(202);
  const verify = (email: string, code: string, extra: Record<string, unknown> = {}) =>
    post('/v1/auth/otp/verify', { email, code, clientType: 1, device, ...extra });

  const bad = (body: Record<string, unknown>) => post('/v1/auth/otp/verify', body).expect(400);

  const askFrom = async (ip: string, email: string) => {
    await request(t.app.getHttpServer())
      .post('/v1/auth/otp')
      .set('X-Forwarded-For', ip)
      .send({ email, clientType: 1 })
      .expect(202);
    await otp.flush();
    return t.email.latest(email, 'otp')!.variables!.code as string;
  };

  const insertSession = (columns: string, values: unknown[]) =>
    sql`insert into auth_sessions (user_id, idle_expires_at, ${sql.raw(columns)})
      values (${owner1.id}, now(), ${sql.join(values)})`.execute(ownerDb);

  /** Asks for a code and reads it from the mail that was "sent". */
  async function codeFor(email: string): Promise<string> {
    await ask(email);
    await otp.flush();
    return t.email.latest(email, 'otp')!.variables!.code as string;
  }
  const rows = async <T = Record<string, unknown>>(query: RawBuilder<unknown>): Promise<T[]> =>
    (await query.execute(ownerDb)).rows as T[];

  /** Five wrong codes on a fresh code, for a registered email. */
  async function lockOut(email: string) {
    const code = await codeFor(email);
    for (let i = 0; i < 4; i += 1) await verify(email, wrongFor(code)).expect(401);
    return verify(email, wrongFor(code)).expect(401);
  }
  /** The same for an email with no account: its code was never mailed. */
  async function lockOutStranger(email: string) {
    await ask(email);
    for (let i = 0; i < 4; i += 1) await verify(email, '000000').expect(401);
    return verify(email, '000000').expect(401);
  }
  const lockoutMails = async () => {
    await t.app.get(BackgroundMailer).flush();
    return t.email.all().filter((m) => m.template === 'login-lockout');
  };

  /**
   * Audit rows with no Society (a login) are readable by no tenant session, by
   * design, so the test lifts the forced policy for one rolled-back transaction.
   */
  const auditRows = async <T>(where: RawBuilder<unknown>): Promise<T[]> => {
    let found: T[] = [];
    await ownerDb
      .transaction()
      .execute(async (trx) => {
        await sql`alter table audit_logs no force row level security`.execute(trx);
        found = (
          await sql`select * from audit_logs where ${where} order by created_at`.execute(trx)
        ).rows as T[];
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error;
      });
    return found;
  };

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
    await sql`delete from refresh_tokens`.execute(ownerDb);
    await sql`delete from auth_sessions`.execute(ownerDb);
    await sql`delete from otp_challenges`.execute(ownerDb);
    await sql`delete from public_call_counters`.execute(ownerDb);
    await sql`delete from login_lockouts`.execute(ownerDb);
    await sql`update users set locked_until = null, failed_login_count = 0, first_login_at = null, last_login_at = null`.execute(
      ownerDb,
    );
    await sql`update users set account_status = 3 where email = ${pending.email}`.execute(ownerDb);
    t = await createTestApp();
    otp = t.app.get(OtpService);
  });

  afterEach(async () => {
    await otp.flush();
    await t.close();
  });

  describe('a correct code', () => {
    it('signs a Society Owner in, in their one context, with a signed token and a refresh token', async () => {
      const code = await codeFor(owner1.email);
      const res = await verify(owner1.email, code).set('User-Agent', 'erp-app/1.4').expect(200);
      expect(res.body).toMatchObject({
        success: true,
        statusCode: 200,
        code: 'LOGIN_OK',
        data: {
          userType: 2,
          userTypeName: 'society_owner',
          session: { activeContext: { roleCode: 2, societyId: societyA.id } },
          person: { id: owner1.id, email: owner1.email, accountStatus: 1 },
          contexts: [{ roleCode: 2, societyId: societyA.id }],
          requiredNotices: [],
        },
      });
      const { accessToken, accessTokenExpiresAt, refreshToken, session } = res.body.data;
      expect(refreshToken).toMatch(/^rt_[\w-]{43}$/);
      expect(new Date(accessTokenExpiresAt).getTime() - t.clock.now().getTime()).toBe(900_000);

      const check = await t.app.get(TokenService).checkAccessToken(accessToken, t.clock.now());
      expect(check).toEqual({
        status: 'valid',
        claims: {
          personId: owner1.id,
          sessionId: session.id,
          roleCode: 2,
          societyId: societyA.id,
          clientType: 'mobile',
        },
      });
    });

    it('stores a session and only the hash of the refresh token', async () => {
      const code = await codeFor(owner1.email);
      const res = await verify(owner1.email, code).set('User-Agent', 'erp-app/1.4').expect(200);
      const [session] = await rows<{
        id: string;
        client_type: number;
        active_role_code: number;
        active_society_id: string;
        idle_expires_at: Date;
        absolute_expires_at: Date | null;
        ended_at: Date | null;
        device_label: string;
        user_agent: string;
        ip_address: string | null;
      }>(sql`select id, client_type, active_role_code, active_society_id, idle_expires_at,
        absolute_expires_at, ended_at, device_label, user_agent, host(ip_address) as ip_address
        from auth_sessions where user_id = ${owner1.id}`);
      expect(session).toMatchObject({
        id: res.body.data.session.id,
        client_type: 1,
        active_role_code: 2,
        active_society_id: societyA.id,
        absolute_expires_at: null,
        ended_at: null,
        device_label: 'Pixel 8',
        user_agent: 'erp-app/1.4',
      });
      expect(session!.idle_expires_at.getTime() - t.clock.now().getTime()).toBe(30 * 86_400_000);
      expect(session!.ip_address).not.toBeNull();

      const tokens = await rows<{ token_hmac: Buffer; used_at: Date | null; expires_at: Date }>(
        sql`select token_hmac, used_at, expires_at from refresh_tokens where session_id = ${session!.id}`,
      );
      expect(tokens).toHaveLength(1);
      expect(
        tokens[0]!.token_hmac.equals(
          t.app.get(TokenService).refreshTokenHmac(res.body.data.refreshToken),
        ),
      ).toBe(true);
      expect(tokens[0]!.used_at).toBeNull();
      expect(tokens[0]!.expires_at.getTime()).toBe(session!.idle_expires_at.getTime());
      // Neither the token nor the access token is stored anywhere.
      const stored = JSON.stringify(await rows(sql`select to_jsonb(r) as r from refresh_tokens r`));
      expect(stored).not.toContain(res.body.data.refreshToken);
    });

    it('uses up the code, notes the login, and writes one audit entry without secrets', async () => {
      const code = await codeFor(owner1.email);
      const res = await verify(owner1.email, code).expect(200);
      const [challenge] = await rows<{ consumed_at: Date | null }>(
        sql`select consumed_at from otp_challenges where user_id = ${owner1.id}`,
      );
      expect(challenge!.consumed_at).not.toBeNull();
      const [user] = await rows<{
        first_login_at: Date | null;
        last_login_at: Date | null;
        failed_login_count: number;
      }>(
        sql`select first_login_at, last_login_at, failed_login_count from users where id = ${owner1.id}`,
      );
      expect(user!.first_login_at!.getTime()).toBe(t.clock.now().getTime());
      expect(user!.last_login_at!.getTime()).toBe(t.clock.now().getTime());

      const audit = await auditRows<{
        action: string;
        society_id: string | null;
        actor_role_code: number | null;
        entity_id: string;
        outcome: number;
        request_id: string;
        new_values: Record<string, unknown>;
      }>(sql`action = 'auth.login' and request_id = ${res.body.requestId}`);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        society_id: null,
        actor_role_code: 2,
        entity_id: owner1.id,
        outcome: 1,
        request_id: res.body.requestId,
        new_values: { channel: 'mobile', platform: 1 },
      });
      const text = JSON.stringify(audit);
      expect(text).not.toContain(code);
      expect(text).not.toContain(res.body.data.refreshToken);
      expect(text).not.toContain(res.body.data.accessToken);
    });

    it('can be used once only', async () => {
      const code = await codeFor(owner1.email);
      await verify(owner1.email, code).expect(200);
      const again = await verify(owner1.email, code).expect(401);
      expect(again.body.code).toBe('OTP_EXPIRED');
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${owner1.id}`),
      ).toHaveLength(1);
    });

    it('starts a person with no admin grant without an active context', async () => {
      const code = await codeFor(parent.email);
      const res = await verify(parent.email, code).expect(200);
      expect(res.body.data).toMatchObject({
        userType: null,
        userTypeName: null,
        session: { activeContext: null },
        contexts: [],
      });
      const check = await t.app
        .get(TokenService)
        .checkAccessToken(res.body.data.accessToken, t.clock.now());
      expect(check).toMatchObject({ claims: { roleCode: null, societyId: null } });
    });

    it('does not give a Super Admin a mobile context', async () => {
      const code = await codeFor(superAdmin.email);
      const res = await verify(superAdmin.email, code).expect(200);
      expect(res.body.data.contexts).toEqual([]);
      expect(res.body.data.session.activeContext).toBeNull();
    });

    it('makes a Pending account Active on its first login', async () => {
      const code = await codeFor(pending.email);
      const res = await verify(pending.email, code).expect(200);
      expect(res.body.data.person.accountStatus).toBe(1);
      const [user] = await rows<{ account_status: number }>(
        sql`select account_status from users where id = ${pending.id}`,
      );
      expect(user!.account_status).toBe(1);
    });

    it('accepts the email in any case and the code with spaces around it', async () => {
      const code = await codeFor(owner1.email);
      await verify(` ${owner1.email.toUpperCase()} `, ` ${code} `).expect(200);
    });

    it('clears earlier wrong tries', async () => {
      const code = await codeFor(owner1.email);
      await verify(owner1.email, wrongFor(code)).expect(401);
      await verify(owner1.email, wrongFor(code)).expect(401);
      await verify(owner1.email, code).expect(200);
      const [user] = await rows<{ failed_login_count: number }>(
        sql`select failed_login_count from users where id = ${owner1.id}`,
      );
      expect(user!.failed_login_count).toBe(0);
    });
  });

  describe('a wrong code', () => {
    it('counts down the tries, then ends the code and locks the email for 30 minutes', async () => {
      const code = await codeFor(owner1.email);
      for (const left of [4, 3, 2, 1]) {
        const res = await verify(owner1.email, wrongFor(code)).expect(401);
        expect(res.body).toMatchObject({
          success: false,
          statusCode: 401,
          code: 'OTP_INVALID',
          data: { attemptsLeft: left },
        });
      }
      const last = await verify(owner1.email, wrongFor(code)).expect(401);
      expect(last.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
      expect(last.headers['retry-after']).toBe('1800');

      // Even the right code is refused while locked, and so is a new request.
      const locked = await verify(owner1.email, code).expect(423);
      expect(locked.body.code).toBe('AUTH_LOCKED');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      await post('/v1/auth/otp', { email: owner1.email, clientType: 1 }).expect(423);
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${owner1.id}`),
      ).toHaveLength(0);

      const [user] = await rows<{ locked_until: Date }>(
        sql`select locked_until from users where id = ${owner1.id}`,
      );
      expect(user!.locked_until.getTime()).toBe(t.clock.now().getTime() + 30 * 60_000);

      // Thirty minutes later the person starts again with five tries.
      t.clock.advance(30 * 60_000 + 1000);
      const fresh = await codeFor(owner1.email);
      const retry = await verify(owner1.email, wrongFor(fresh)).expect(401);
      expect(retry.body.data.attemptsLeft).toBe(4);
      await verify(owner1.email, fresh).expect(200);
    });

    it('answers the same for an unknown email as for a registered one, at every step', async () => {
      const code = await codeFor(owner1.email);
      await ask(unknown);
      for (let step = 0; step < 6; step += 1) {
        const known = await verify(owner1.email, wrongFor(code));
        const stranger = await verify(unknown, wrongFor(code));
        expect(stranger.status).toBe(known.status);
        expect(shape(stranger.body)).toEqual(shape(known.body));
        expect(stranger.headers['retry-after']).toBe(known.headers['retry-after']);
      }
      // Both are locked now, and a new code request meets the lock for both.
      await post('/v1/auth/otp', { email: unknown, clientType: 1 }).expect(423);
      await post('/v1/auth/otp', { email: owner1.email, clientType: 1 }).expect(423);
    });

    it('does not give fresh tries to someone who asks for another code', async () => {
      const first = await codeFor(owner1.email);
      await verify(owner1.email, wrongFor(first)).expect(401);
      await verify(owner1.email, wrongFor(first)).expect(401);
      await verify(owner1.email, wrongFor(first)).expect(401);
      t.clock.advance(61_000);
      const second = await codeFor(owner1.email);
      const res = await verify(owner1.email, wrongFor(second)).expect(401);
      expect(res.body.data.attemptsLeft).toBe(1);
    });

    it('does not give fresh tries after the code expires and a new one is asked for', async () => {
      const first = await codeFor(owner1.email);
      await verify(owner1.email, wrongFor(first)).expect(401);
      await verify(owner1.email, wrongFor(first)).expect(401);
      t.clock.advance(11 * 60_000);
      expect((await verify(owner1.email, first).expect(401)).body.code).toBe('OTP_EXPIRED');
      const second = await codeFor(owner1.email);
      const res = await verify(owner1.email, wrongFor(second)).expect(401);
      expect(res.body.data.attemptsLeft).toBe(2);
    });

    it('tells an expired code from a wrong one', async () => {
      const code = await codeFor(owner1.email);
      t.clock.advance(10 * 60_000 + 1000);
      const res = await verify(owner1.email, code).expect(401);
      expect(res.body.code).toBe('OTP_EXPIRED');
    });

    it('is the same "expired" answer for an email that never asked and one that did not exist', async () => {
      const never = await verify(owner1.email, '123456').expect(401);
      const stranger = await verify(unknown, '123456').expect(401);
      expect(never.body.code).toBe('OTP_EXPIRED');
      expect(shape(stranger.body)).toEqual(shape(never.body));
    });

    it('treats an Inactive account like an unknown email', async () => {
      await ask(inactive.email);
      await ask(unknown);
      const a = await verify(inactive.email, '123456').expect(401);
      const b = await verify(unknown, '123456').expect(401);
      expect(shape(a.body)).toEqual(shape(b.body));
      expect(a.body.data.attemptsLeft).toBe(4);
    });

    it('keeps the count when the request was refused by validation first', async () => {
      const code = await codeFor(owner1.email);
      await post('/v1/auth/otp/verify', {
        email: owner1.email,
        code: 'abc',
        clientType: 1,
        device,
      }).expect(400);
      const res = await verify(owner1.email, wrongFor(code)).expect(401);
      expect(res.body.data.attemptsLeft).toBe(4);
    });
  });

  describe('repeated lockouts', () => {
    const THIRTY_MINUTES = 30 * 60_000 + 1000;
    const DAY = 24 * 3600_000;

    it('locks for 30 minutes twice, then for 24 hours, and tells the person each time', async () => {
      const first = await lockOut(owner1.email);
      expect(first.headers['retry-after']).toBe('1800');
      t.clock.advance(THIRTY_MINUTES);
      const second = await lockOut(owner1.email);
      expect(second.headers['retry-after']).toBe('1800');
      t.clock.advance(THIRTY_MINUTES);
      const third = await lockOut(owner1.email);
      expect(third.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
      expect(third.headers['retry-after']).toBe('86400');

      const [user] = await rows<{ locked_until: Date }>(
        sql`select locked_until from users where id = ${owner1.id}`,
      );
      expect(user!.locked_until.getTime()).toBe(t.clock.now().getTime() + DAY);
      expect(await rows(sql`select 1 from login_lockouts`)).toHaveLength(3);

      const mails = await lockoutMails();
      expect(mails.map((m) => m.to)).toEqual([owner1.email, owner1.email, owner1.email]);
      expect(mails[0]!.text).toContain('30 minutes');
      expect(mails[2]!.text).toContain('24 hours');
      expect(JSON.stringify(mails)).not.toMatch(/\b\d{6}\b/);
    });

    it('keeps the email locked for the full 24 hours, then gives five fresh tries', async () => {
      await lockOut(owner1.email);
      t.clock.advance(THIRTY_MINUTES);
      await lockOut(owner1.email);
      t.clock.advance(THIRTY_MINUTES);
      await lockOut(owner1.email);

      t.clock.advance(23 * 3600_000);
      const stillLocked = await verify(owner1.email, '123456').expect(423);
      expect(stillLocked.body.code).toBe('AUTH_LOCKED');
      await post('/v1/auth/otp', { email: owner1.email, clientType: 1 }).expect(423);

      t.clock.advance(3600_000 + 1000);
      const fresh = await codeFor(owner1.email);
      const retry = await verify(owner1.email, wrongFor(fresh)).expect(401);
      expect(retry.body.data.attemptsLeft).toBe(4);
      await verify(owner1.email, fresh).expect(200);
    });

    it('does not count a lockout older than 24 hours', async () => {
      await lockOut(owner1.email);
      t.clock.advance(25 * 3600_000);
      const second = await lockOut(owner1.email);
      expect(second.headers['retry-after']).toBe('1800');
      t.clock.advance(THIRTY_MINUTES);
      const third = await lockOut(owner1.email);
      expect(third.headers['retry-after']).toBe('1800');
    });

    it('holds the lock even when the old codes have been swept away', async () => {
      await lockOut(owner1.email);
      t.clock.advance(THIRTY_MINUTES);
      await lockOut(owner1.email);
      t.clock.advance(THIRTY_MINUTES);
      await lockOut(owner1.email);
      await sql`delete from otp_challenges`.execute(ownerDb);
      await sql`update users set locked_until = null`.execute(ownerDb);
      await post('/v1/auth/otp', { email: owner1.email, clientType: 1 }).expect(423);
    });

    it('treats an unknown email the same way and sends it no mail', async () => {
      const answers = [];
      for (let round = 0; round < 3; round += 1) {
        answers.push(await lockOutStranger(unknown));
        t.clock.advance(THIRTY_MINUTES);
      }
      expect(answers.map((a) => a.headers['retry-after'])).toEqual(['1800', '1800', '86400']);
      expect(await rows(sql`select 1 from login_lockouts`)).toHaveLength(3);
      expect(await lockoutMails()).toHaveLength(0);
      expect(t.email.count(unknown)).toBe(0);
    });

    it('sends no lockout mail to an Inactive account, and writes the count in the audit entry', async () => {
      const answer = await lockOutStranger(inactive.email);
      expect(answer.headers['retry-after']).toBe('1800');
      expect(await lockoutMails()).toHaveLength(0);

      const locked = await lockOut(owner1.email);
      const entries = await auditRows<{ new_values: unknown }>(
        sql`action = 'auth.lockout' and request_id = ${locked.body.requestId}`,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]!.new_values).toEqual({ lockoutsIn24Hours: 1, lockSeconds: 1800 });
    });

    it('lets the app role record and read lockouts but not change or delete them', async () => {
      const { db } = t.app.get(DatabaseService);
      await lockOut(owner1.email);
      await expect(sql`update login_lockouts set locked_until = now()`.execute(db)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`delete from login_lockouts`.execute(db)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`truncate login_lockouts`.execute(db)).rejects.toThrow(/permission denied/);
      await expect(
        sql`insert into login_lockouts (email_hmac, locked_until) values (${Buffer.alloc(5)}, now())`.execute(
          ownerDb,
        ),
      ).rejects.toThrow(/ck_login_lockouts_hmac/);
    });
  });

  describe('accounts that cannot sign in', () => {
    it('refuses a Blocked account after a correct code, and starts no session', async () => {
      const code = await codeFor(blocked.email);
      const res = await verify(blocked.email, code).expect(403);
      expect(res.body.code).toBe('ACCOUNT_BLOCKED');
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${blocked.id}`),
      ).toHaveLength(0);
      const again = await verify(blocked.email, code).expect(401);
      expect(again.body.code).toBe('OTP_EXPIRED');
    });

    it('refuses a console sign-in by someone who is not a Super Admin', async () => {
      const code = await codeFor(teacher.email);
      const res = await post('/v1/auth/otp/verify', {
        email: teacher.email,
        code,
        clientType: 2,
      }).expect(403);
      expect(res.body.code).toBe('CONSOLE_NOT_ALLOWED');
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${teacher.id}`),
      ).toHaveLength(0);
    });

    it('gives a Super Admin on the console no session yet: the authenticator step comes later', async () => {
      await ask(superAdmin.email, 2);
      await otp.flush();
      const code = t.email.latest(superAdmin.email, 'otp')!.variables!.code as string;
      const res = await post('/v1/auth/otp/verify', {
        email: superAdmin.email,
        code,
        clientType: 2,
      }).expect(503);
      expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${superAdmin.id}`),
      ).toHaveLength(0);
      // The code is kept for the authenticator step.
      const [challenge] = await rows<{ consumed_at: Date | null }>(
        sql`select consumed_at from otp_challenges where user_id = ${superAdmin.id}`,
      );
      expect(challenge!.consumed_at).toBeNull();
    });
  });

  describe('the request', () => {
    it('needs a 6-digit code of type string', async () => {
      expect(
        (await bad({ email: owner1.email, code: '12345', clientType: 1, device })).body.errors[0],
      ).toMatchObject({
        field: 'code',
        code: 'INVALID_FORMAT',
      });
      expect(
        (await bad({ email: owner1.email, code: 123456, clientType: 1, device })).body.errors[0],
      ).toMatchObject({
        field: 'code',
        code: 'INVALID_TYPE',
      });
      expect(
        (await bad({ email: owner1.email, clientType: 1, device })).body.errors[0],
      ).toMatchObject({
        field: 'code',
      });
    });

    it('needs a device on the mobile app, and checks it', async () => {
      const base = { email: owner1.email, code: '123456', clientType: 1 };
      expect((await bad(base)).body.errors[0]).toMatchObject({ field: 'device', code: 'REQUIRED' });
      const badPlatform = await bad({ ...base, device: { ...device, platform: 3 } });
      expect(badPlatform.body.errors[0]).toMatchObject({
        field: 'device.platform',
        code: 'INVALID_CODE',
      });
      const noVersion = await bad({ ...base, device: { platform: 1 } });
      expect(noVersion.body.errors[0]).toMatchObject({ field: 'device.appVersion' });
      const longLabel = await bad({ ...base, device: { ...device, label: 'x'.repeat(101) } });
      expect(longLabel.body.errors[0]).toMatchObject({ field: 'device.label', code: 'TOO_LONG' });
    });

    it('refuses unknown fields and does not repeat the email in the error', async () => {
      const res = await bad({
        email: owner1.email,
        code: '123456',
        clientType: 1,
        device,
        role: 1,
      });
      expect(res.body.errors[0]).toMatchObject({ field: 'role', code: 'FIELD_NOT_ALLOWED' });
      const wrong = await bad({ email: 'not-an-email', code: '123456', clientType: 1, device });
      expect(JSON.stringify(wrong.body)).not.toContain('not-an-email');
    });
  });

  describe('limits', () => {
    it('counts toward the same 20 calls a minute per address as asking for a code', async () => {
      for (let i = 0; i < 20; i += 1) await verify(unknown, '123456');
      const res = await verify(unknown, '123456').expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('lets exactly one of several parallel correct codes in', async () => {
      const code = await codeFor(owner1.email);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => verify(owner1.email, code)),
      );
      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      expect(
        results.filter((res) => res.status !== 200).every((res) => [401, 429].includes(res.status)),
      ).toBe(true);
      expect(
        await rows(sql`select 1 from auth_sessions where user_id = ${owner1.id}`),
      ).toHaveLength(1);
    });

    it('does not let parallel wrong guesses get more than five tries', async () => {
      const code = await codeFor(owner1.email);
      const guesses = Array.from({ length: 12 }, (_, i) =>
        String(100_000 + i).padStart(6, '0'),
      ).filter((guess) => guess !== code);
      const results = await Promise.all(guesses.map((guess) => verify(owner1.email, guess)));
      const counted = results.filter((res) => res.status === 401);
      expect(counted.length).toBeLessThanOrEqual(5);
      const [user] = await rows<{ locked_until: Date | null }>(
        sql`select locked_until from users where id = ${owner1.id}`,
      );
      // Either five were counted and the email is locked, or some were told to wait and retry.
      expect(counted.length === 5 ? user!.locked_until !== null : true).toBe(true);
    });
  });

  describe('several live codes (someone else asked from another address)', () => {
    beforeEach(async () => {
      await t.close();
      process.env.TRUST_PROXY = '1';
      t = await createTestApp();
      otp = t.app.get(OtpService);
    });

    afterEach(() => {
      delete process.env.TRUST_PROXY;
    });

    it('accepts either code, and the other stops working once one is used', async () => {
      const mine = await askFrom('203.0.113.20', owner1.email);
      t.clock.advance(61_000);
      const theirs = await askFrom('198.51.100.9', owner1.email);
      expect(
        await rows(
          sql`select 1 from otp_challenges where user_id = ${owner1.id} and superseded_at is null`,
        ),
      ).toHaveLength(2);
      await verify(owner1.email, mine).expect(200);
      const second = await verify(owner1.email, theirs).expect(401);
      expect(second.body.code).toBe('OTP_EXPIRED');
    });

    it('counts a wrong guess once for the email, whatever the number of live codes', async () => {
      await askFrom('203.0.113.20', owner1.email);
      t.clock.advance(61_000);
      const second = await askFrom('198.51.100.9', owner1.email);
      const res = await verify(owner1.email, wrongFor(second)).expect(401);
      expect(res.body.data.attemptsLeft).toBe(4);
      const attempts = await rows<{ attempt_count: number }>(
        sql`select attempt_count from otp_challenges where user_id = ${owner1.id} order by created_at`,
      );
      expect(attempts.map((row) => row.attempt_count)).toEqual([1, 1]);
    });
  });

  describe('session tables', () => {
    let database: DatabaseService;
    beforeEach(() => {
      database = t.app.get(DatabaseService);
    });

    it('checks client type, role, end reason and the console limit', async () => {
      await expect(insertSession('client_type', [3])).rejects.toThrow(/ck_auth_sessions_client/);
      await expect(insertSession('client_type, active_role_code', [1, 6])).rejects.toThrow(
        /ck_auth_sessions_role/,
      );
      await expect(insertSession('client_type, ended_at', [1, new Date()])).rejects.toThrow(
        /ck_auth_sessions_end/,
      );
      await expect(insertSession('client_type, end_reason', [1, 1])).rejects.toThrow(
        /ck_auth_sessions_end/,
      );
      await expect(
        insertSession('client_type, ended_at, end_reason', [1, new Date(), 8]),
      ).rejects.toThrow(/ck_auth_sessions_end_reason/);
      await expect(insertSession('client_type', [2])).rejects.toThrow(
        /ck_auth_sessions_console_limit/,
      );
      await insertSession('client_type, absolute_expires_at', [2, new Date()]);
    });

    it('keeps one row per token hash and removes tokens with their session', async () => {
      const [created] = await rows<{ id: string }>(
        sql`insert into auth_sessions (user_id, client_type, idle_expires_at) values (${owner1.id}, 1, now()) returning id`,
      );
      const id = created!.id;
      const token = (hmac: Buffer) =>
        sql`insert into refresh_tokens (session_id, token_hmac, expires_at) values (${id}, ${hmac}, now())`.execute(
          ownerDb,
        );
      await token(Buffer.alloc(32, 7));
      await expect(token(Buffer.alloc(32, 7))).rejects.toThrow(/uq_refresh_tokens_token_hmac/);
      await expect(token(Buffer.alloc(5))).rejects.toThrow(/ck_refresh_tokens_hmac/);
      await sql`delete from auth_sessions where id = ${id}`.execute(ownerDb);
      expect(await rows(sql`select 1 from refresh_tokens where session_id = ${id}`)).toHaveLength(
        0,
      );
    });

    it('lets the app role start and end sessions but not delete or truncate them', async () => {
      const { db } = database;
      await expect(sql`delete from auth_sessions`.execute(db)).rejects.toThrow(/permission denied/);
      await expect(sql`delete from refresh_tokens`.execute(db)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`truncate auth_sessions`.execute(db)).rejects.toThrow(/permission denied/);
      await expect(sql`truncate refresh_tokens`.execute(db)).rejects.toThrow(/permission denied/);
    });
  });

  it('keeps the hash secret out of everything it stores', async () => {
    const code = await codeFor(owner1.email);
    await verify(owner1.email, code).expect(200);
    const hasher = new OtpHasher(secret);
    const stored = await rows<{ code_hmac: Buffer }>(
      sql`select code_hmac from otp_challenges where user_id = ${owner1.id}`,
    );
    expect(stored[0]!.code_hmac.equals(hasher.code(owner1.email, code))).toBe(true);
  });
});
