// QA for Phase 1 B4: refresh storms, races with logout, what refresh leaves in
// logs and headers, and many people refreshing behind one address.
import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { clearLoginState } from '../support/login-state.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
let owner: Kysely<unknown>;
const person = personaByKey('SO-A1').email;

describe('QA: AUTH-05, AUTH-07, AUTH-08', () => {
  let t: TestApp;
  const signIn = (email: string, ip = '203.0.113.7') => signInMobile(t, email, ip);
  const server = () => t.app.getHttpServer();
  const refresh = (refreshToken: string, ip = '203.0.113.7') =>
    request(server()).post('/v1/auth/refresh').set('X-Forwarded-For', ip).send({ refreshToken });
  const call = (path: string, token: string) =>
    request(server()).post(path).set('Authorization', `Bearer ${token}`).send({});

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    owner = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(owner);
  });
  afterAll(async () => {
    await owner.destroy();
  });
  beforeEach(async () => {
    await clearLoginState(owner);
    await sql`update users set locked_until = null, failed_login_count = 0`.execute(owner);
    process.env.TRUST_PROXY = '1';
    t = await createTestApp({ captureLogs: true });
  });
  afterEach(async () => {
    await t.app.get(OtpService).flush();
    await t.close();
    delete process.env.TRUST_PROXY;
  });

  it('a storm of 20 parallel refreshes with one token: one winner, the session ends, nothing from it works', async () => {
    const s = await signIn(person);
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => refresh(s.refreshToken, `192.0.2.${i + 1}`)),
    );
    const winners = answers.filter((a) => a.status === 200);
    expect(winners).toHaveLength(1);
    expect(new Set(answers.filter((a) => a.status !== 200).map((a) => a.body.code))).toEqual(
      new Set(
        ['REFRESH_TOKEN_REUSED', 'SESSION_ENDED'].filter((c) =>
          answers.some((a) => a.body.code === c),
        ),
      ),
    );
    expect(
      answers.filter((a) => a.body.code === 'REFRESH_TOKEN_REUSED').length,
    ).toBeGreaterThanOrEqual(1);
    const won = winners[0]!.body.data;
    expect((await refresh(won.refreshToken, '192.0.2.99')).body.code).toBe('SESSION_ENDED');
    expect((await call('/v1/auth/logout', won.accessToken)).status).toBe(401);
    const { rows } = await sql<{
      n: number;
    }>`select count(*)::int as n from refresh_tokens where used_at is null`.execute(owner);
    console.log(
      `QA: storm answers ${answers.map((a) => a.body.code).join(',')}; unused tokens left ${rows[0]!.n}`,
    );
  });

  it('a refresh racing a logout never leaves a token that works', async () => {
    for (let i = 0; i < 10; i += 1) {
      const s = await signIn(person, `198.51.100.${i + 1}`);
      const [r] = await Promise.all([
        refresh(s.refreshToken, `192.0.2.${i + 1}`),
        call('/v1/auth/logout', s.accessToken),
      ]);
      if (r.status === 200) {
        expect((await call('/v1/auth/logout', r.body.data.accessToken)).status).toBe(401);
        expect((await refresh(r.body.data.refreshToken, `192.0.2.${i + 50}`)).status).toBe(401);
      }
      t.clock.advance(15 * 60_000);
    }
  });

  it('logout-all on another device stops this device’s refresh and access token', async () => {
    const a = await signIn(person, '198.51.100.1');
    const b = await signIn(person, '198.51.100.2');
    await call('/v1/auth/logout-all', b.accessToken).expect(200);
    expect((await refresh(a.refreshToken)).body).toMatchObject({
      code: 'SESSION_ENDED',
      data: { reason: expect.any(String) },
    });
    expect((await call('/v1/auth/logout', a.accessToken)).status).toBe(401);
  });

  it('a refresh answer is not cached, and no token reaches the logs', async () => {
    const s = await signIn(person);
    const res = await refresh(s.refreshToken).expect(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    await refresh(s.refreshToken); // a reuse, audited
    const logs = JSON.stringify(t.logs);
    for (const secret of [
      s.refreshToken,
      s.accessToken,
      res.body.data.refreshToken,
      res.body.data.accessToken,
    ]) {
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain(secret.slice(-20));
    }
  });

  it('R1: 21 people refreshing behind one address in one minute (a school Wi-Fi or a mobile carrier NAT)', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      tokens.push((await signIn(person, `198.51.100.${i + 1}`)).refreshToken);
      await sql`delete from public_call_counters`.execute(owner);
      t.clock.advance(15 * 60_000);
    }
    const statuses: number[] = [];
    for (const token of tokens) statuses.push((await refresh(token, '100.64.0.1')).status);
    console.log(
      `QA R1: ${statuses.filter((s) => s === 200).length} renewed, ${statuses.filter((s) => s === 429).length} refused`,
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(21);
  });
});
