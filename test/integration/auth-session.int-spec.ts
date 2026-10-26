import { Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { TokenService } from '../../src/platform/identity/token.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { FixtureModule } from '../support/fixture.module.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

const owner = personaByKey('SO-A1');
const other = personaByKey('SO-B1');
const parent = personaByKey('P-A1-one');
const device = { platform: 1, label: 'Pixel 8', appVersion: '1.4.0' };
const DAY = 24 * 3600_000;
const MINUTE = 60_000;

describe('AUTH-05, AUTH-07, AUTH-08 and the per-request session check', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let otp: OtpService;

  const rows = async <T = Record<string, unknown>>(query: RawBuilder<unknown>): Promise<T[]> =>
    (await query.execute(ownerDb)).rows as T[];
  const post = (path: string, body: Record<string, unknown> = {}) =>
    request(t.app.getHttpServer()).post(path).send(body);
  const refresh = (refreshToken: string) => post('/v1/auth/refresh', { refreshToken });
  const call = (method: 'get' | 'post', path: string, token: string) =>
    request(t.app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`).send({});
  const logout = (token: string) => call('post', '/v1/auth/logout', token);

  /** Signs a person in on a fresh device and returns the tokens. */
  async function signIn(email: string, ip = '203.0.113.7') {
    await request(t.app.getHttpServer())
      .post('/v1/auth/otp')
      .set('X-Forwarded-For', ip)
      .send({ email, clientType: 1 })
      .expect(202);
    await otp.flush();
    const code = t.email.latest(email, 'otp')!.variables!.code as string;
    const res = await request(t.app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .set('X-Forwarded-For', ip)
      .send({ email, code, clientType: 1, device })
      .expect(200);
    t.clock.advance(61_000);
    const { accessToken, refreshToken, session } = res.body.data;
    return {
      accessToken: accessToken as string,
      refreshToken: refreshToken as string,
      sessionId: session.id as string,
    };
  }

  const sessionRow = async (id: string) =>
    (
      await rows<{
        ended_at: Date | null;
        end_reason: number | null;
        idle_expires_at: Date;
        last_used_at: Date;
      }>(
        sql`select ended_at, end_reason, idle_expires_at, last_used_at from auth_sessions where id = ${id}`,
      )
    )[0]!;

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
    await sql`update users set locked_until = null, failed_login_count = 0`.execute(ownerDb);
    await sql`update users set account_status = 1, blocked_at = null, blocked_by = null, block_reason = null where id in (${owner.id}, ${other.id}, ${parent.id})`.execute(
      ownerDb,
    );
    await sql`update role_assignments set revoked_at = null, revoked_by = null, revoke_reason = null`.execute(
      ownerDb,
    );
    t = await createTestApp({ imports: [FixtureModule] });
    otp = t.app.get(OtpService);
  });

  afterEach(async () => {
    await otp.flush();
    await t.close();
  });

  describe('refresh', () => {
    it('gives a new access token and a new refresh token, and uses the old one up', async () => {
      const first = await signIn(owner.email);
      t.clock.advance(5 * MINUTE);
      const res = await refresh(first.refreshToken).expect(200);
      expect(res.body).toMatchObject({ success: true, code: 'REFRESH_OK' });
      const { accessToken, refreshToken, accessTokenExpiresAt } = res.body.data;
      expect(refreshToken).toMatch(/^rt_[\w-]{43}$/);
      expect(refreshToken).not.toBe(first.refreshToken);
      expect(new Date(accessTokenExpiresAt).getTime() - t.clock.now().getTime()).toBe(15 * MINUTE);
      await call('post', '/v1/fixtures/owner-write', accessToken).expect(200);

      const [old] = await rows<{ used_at: Date | null }>(
        sql`select used_at from refresh_tokens where session_id = ${first.sessionId} order by created_at limit 1`,
      );
      expect(old!.used_at?.getTime()).toBe(t.clock.now().getTime());
      expect(
        await rows(sql`select 1 from refresh_tokens where session_id = ${first.sessionId}`),
      ).toHaveLength(2);
      // The session lasts 30 days from this use.
      const session = await sessionRow(first.sessionId);
      expect(session.idle_expires_at.getTime()).toBe(t.clock.now().getTime() + 30 * DAY);
    });

    it('keeps the active context of the session in the new token', async () => {
      const first = await signIn(owner.email);
      const res = await refresh(first.refreshToken).expect(200);
      const check = await t.app
        .get(TokenService)
        .checkAccessToken(res.body.data.accessToken, t.clock.now());
      expect(check).toMatchObject({
        status: 'valid',
        claims: { roleCode: 2, sessionId: first.sessionId },
      });
    });

    it('treats a used token as a copy: the session ends and nothing from it works again', async () => {
      const first = await signIn(owner.email);
      const second = await refresh(first.refreshToken).expect(200);

      const reuse = await refresh(first.refreshToken).expect(401);
      expect(reuse.body).toMatchObject({ success: false, code: 'REFRESH_TOKEN_REUSED' });

      const session = await sessionRow(first.sessionId);
      expect(session.end_reason).toBe(5);
      expect(session.ended_at).not.toBeNull();
      // The newest token and the access tokens of the session are dead too.
      const newest = await refresh(second.body.data.refreshToken).expect(401);
      expect(newest.body).toMatchObject({
        code: 'SESSION_ENDED',
        data: { reason: 'token_reused' },
      });
      const access = await logout(second.body.data.accessToken).expect(401);
      expect(access.body).toMatchObject({
        code: 'SESSION_ENDED',
        data: { reason: 'token_reused' },
      });

      const entries = await auditRows<{ entity_id: string; request_id: string }>(
        sql`action = 'auth.token_reuse' and request_id = ${reuse.body.requestId}`,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entity_id).toBe(owner.id);
    });

    it('lets exactly one of two parallel refreshes with the same token win', async () => {
      const first = await signIn(owner.email);
      const answers = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);
      const statuses = answers.map((a) => a.status).toSorted();
      expect(statuses).toEqual([200, 401]);
      const loser = answers.find((a) => a.status === 401)!;
      expect(loser.body.code).toBe('REFRESH_TOKEN_REUSED');
      // A copied token was used, so the session is over for everyone holding it.
      expect((await sessionRow(first.sessionId)).end_reason).toBe(5);
    });

    it('answers the same for an unknown token and a token of the wrong shape', async () => {
      const unknown = await refresh(`rt_${'A'.repeat(43)}`).expect(401);
      const strange = await refresh('hello').expect(401);
      for (const res of [unknown, strange]) {
        expect(res.body).toMatchObject({
          success: false,
          code: 'REFRESH_TOKEN_INVALID',
          data: null,
        });
      }
    });

    it('validates the body', async () => {
      await post('/v1/auth/refresh', {}).expect(400);
      const typed = await post('/v1/auth/refresh', { refreshToken: 12345 }).expect(400);
      expect(typed.body.errors[0]).toMatchObject({ field: 'refreshToken', code: 'INVALID_TYPE' });
      await post('/v1/auth/refresh', { refreshToken: 'x'.repeat(201) }).expect(400);
      await post('/v1/auth/refresh', { refreshToken: 'rt_x', extra: 1 }).expect(400);
    });

    it('refuses an expired token and ends the session as expired', async () => {
      const first = await signIn(owner.email);
      t.clock.advance(31 * DAY);
      const res = await refresh(first.refreshToken).expect(401);
      expect(res.body.code).toBe('REFRESH_TOKEN_INVALID');
      expect((await sessionRow(first.sessionId)).end_reason).toBe(6);
    });

    it('keeps a session alive for 30 days from its last use', async () => {
      let tokens = await signIn(owner.email);
      for (let week = 0; week < 6; week += 1) {
        t.clock.advance(7 * DAY);
        const res = await refresh(tokens.refreshToken).expect(200);
        tokens = { ...tokens, refreshToken: res.body.data.refreshToken };
      }
      expect((await sessionRow(tokens.sessionId)).ended_at).toBeNull();
    });

    it('ends all sessions of a person who was blocked, and says why', async () => {
      const phone = await signIn(owner.email);
      const tablet = await signIn(owner.email, '203.0.113.8');
      await sql`update users set account_status = 2, blocked_at = now() where id = ${owner.id}`.execute(
        ownerDb,
      );
      const res = await refresh(phone.refreshToken).expect(401);
      expect(res.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'blocked' } });
      expect((await sessionRow(phone.sessionId)).end_reason).toBe(3);
      expect((await sessionRow(tablet.sessionId)).end_reason).toBe(3);
    });

    it('ends a session whose role grant was revoked', async () => {
      const first = await signIn(owner.email);
      await sql`update role_assignments set revoked_at = now(), revoked_by = ${owner.id}, revoke_reason = 'test' where user_id = ${owner.id}`.execute(
        ownerDb,
      );
      const res = await refresh(first.refreshToken).expect(401);
      expect(res.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'admin_revoked' } });
      expect((await sessionRow(first.sessionId)).end_reason).toBe(4);
    });

    it('does not renew a console session from a body token', async () => {
      const tokens = t.app.get(TokenService);
      const fresh = tokens.newRefreshToken();
      const [created] = await rows<{ id: string }>(
        sql`insert into auth_sessions (user_id, client_type, idle_expires_at, absolute_expires_at)
            values (${owner.id}, 2, now() + interval '1 hour', now() + interval '1 hour') returning id`,
      );
      await sql`insert into refresh_tokens (session_id, token_hmac, expires_at)
        values (${created!.id}, ${fresh.hmac}, now() + interval '1 hour')`.execute(ownerDb);
      const res = await refresh(fresh.token).expect(401);
      expect(res.body.code).toBe('REFRESH_TOKEN_INVALID');
    });

    it('counts toward the 20 calls a minute per address', async () => {
      for (let i = 0; i < 20; i += 1) await refresh('rt_nothing').expect(401);
      const limited = await refresh('rt_nothing').expect(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('the check on every request', () => {
    it('lets a live session in and gives the role its place', async () => {
      const { accessToken } = await signIn(owner.email);
      await call('post', '/v1/fixtures/owner-write', accessToken).expect(200);
      await call('get', '/v1/fixtures/admin-only', accessToken).expect(403);
    });

    it('refuses no token, a bad token, a token for another audience and an expired token', async () => {
      const { accessToken } = await signIn(owner.email);
      const http = request(t.app.getHttpServer());
      expect((await http.post('/v1/auth/logout').send({}).expect(401)).body.code).toBe(
        'TOKEN_INVALID',
      );
      expect((await logout('not-a-token').expect(401)).body.code).toBe('TOKEN_INVALID');
      expect((await logout(`${accessToken.slice(0, -4)}AAAA`).expect(401)).body.code).toBe(
        'TOKEN_INVALID',
      );
      t.clock.advance(16 * MINUTE);
      expect((await logout(accessToken).expect(401)).body.code).toBe('TOKEN_EXPIRED');
    });

    it('refuses a signed token whose session does not exist', async () => {
      const { accessToken, sessionId } = await signIn(owner.email);
      await sql`delete from auth_sessions where id = ${sessionId}`.execute(ownerDb);
      expect((await logout(accessToken).expect(401)).body.code).toBe('TOKEN_INVALID');
    });

    it('cuts a blocked person off at the next call, not when the token runs out', async () => {
      const { accessToken, sessionId } = await signIn(owner.email);
      await sql`update users set account_status = 2, blocked_at = now() where id = ${owner.id}`.execute(
        ownerDb,
      );
      const res = await call('post', '/v1/fixtures/owner-write', accessToken).expect(401);
      expect(res.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'blocked' } });
      expect((await sessionRow(sessionId)).end_reason).toBe(3);
    });

    it('cuts off a revoked role grant at the next call', async () => {
      const { accessToken } = await signIn(owner.email);
      await sql`update role_assignments set revoked_at = now(), revoked_by = ${owner.id}, revoke_reason = 'test' where user_id = ${owner.id}`.execute(
        ownerDb,
      );
      const res = await call('post', '/v1/fixtures/owner-write', accessToken).expect(401);
      expect(res.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'admin_revoked' } });
    });

    it('ends a session that sat idle for 30 days', async () => {
      const { accessToken, sessionId } = await signIn(owner.email);
      await sql`update auth_sessions set idle_expires_at = ${new Date(t.clock.now().getTime() - 1000)} where id = ${sessionId}`.execute(
        ownerDb,
      );
      const res = await logout(accessToken).expect(401);
      expect(res.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'expired' } });
      expect((await sessionRow(sessionId)).end_reason).toBe(6);
    });

    it('moves the idle deadline at most every five minutes', async () => {
      const { accessToken, sessionId } = await signIn(owner.email);
      const before = await sessionRow(sessionId);
      t.clock.advance(2 * MINUTE);
      await call('post', '/v1/fixtures/owner-write', accessToken).expect(200);
      expect((await sessionRow(sessionId)).last_used_at).toEqual(before.last_used_at);
      t.clock.advance(4 * MINUTE);
      await call('post', '/v1/fixtures/owner-write', accessToken).expect(200);
      const after = await sessionRow(sessionId);
      expect(after.last_used_at.getTime()).toBe(t.clock.now().getTime());
      expect(after.idle_expires_at.getTime()).toBe(t.clock.now().getTime() + 30 * DAY);
    });

    it('lets a session with no context log out but not use a role endpoint', async () => {
      const { accessToken } = await signIn(parent.email);
      const res = await call('post', '/v1/fixtures/owner-write', accessToken).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      await logout(accessToken).expect(200);
    });
  });

  describe('logout and logout-all', () => {
    it('ends this session only, and says so to the next call and to a refresh', async () => {
      const phone = await signIn(owner.email);
      const tablet = await signIn(owner.email, '203.0.113.8');
      const res = await logout(phone.accessToken).expect(200);
      expect(res.body).toMatchObject({
        success: true,
        statusCode: 200,
        code: 'LOGOUT_OK',
        data: null,
      });

      const again = await logout(phone.accessToken).expect(401);
      expect(again.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'logout' } });
      const renew = await refresh(phone.refreshToken).expect(401);
      expect(renew.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'logout' } });
      expect((await sessionRow(phone.sessionId)).end_reason).toBe(1);
      expect((await sessionRow(tablet.sessionId)).ended_at).toBeNull();
      await call('post', '/v1/fixtures/owner-write', tablet.accessToken).expect(200);

      const entries = await auditRows<{ entity_id: string }>(
        sql`action = 'auth.logout' and request_id = ${res.body.requestId}`,
      );
      expect(entries.map((e) => e.entity_id)).toEqual([owner.id]);
    });

    it('ends every session of the person and no one else’s', async () => {
      const phone = await signIn(owner.email);
      const tablet = await signIn(owner.email, '203.0.113.8');
      const stranger = await signIn(other.email, '203.0.113.9');
      const res = await call('post', '/v1/auth/logout-all', phone.accessToken).expect(200);
      expect(res.body).toMatchObject({ code: 'LOGOUT_ALL_OK', data: null });
      for (const s of [phone, tablet]) expect((await sessionRow(s.sessionId)).end_reason).toBe(2);
      const gone = await call('post', '/v1/fixtures/owner-write', tablet.accessToken).expect(401);
      expect(gone.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'logout_all' } });
      expect((await sessionRow(stranger.sessionId)).ended_at).toBeNull();

      const entries = await auditRows<{ new_values: unknown }>(
        sql`action = 'auth.logout_all' and request_id = ${res.body.requestId}`,
      );
      expect(entries[0]!.new_values).toEqual({ sessionsEnded: 2 });
    });

    it('works for a session with no context', async () => {
      const { accessToken } = await signIn(parent.email);
      await call('post', '/v1/auth/logout-all', accessToken).expect(200);
    });
  });
});
