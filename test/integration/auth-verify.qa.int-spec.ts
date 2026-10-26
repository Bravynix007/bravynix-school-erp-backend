// QA for Phase 1 B3 (AUTH-02): brute force over long sequences, answers that
// could tell emails apart, someone else locking a person out, logs and headers.
import { generateKeyPairSync } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { dumpTables } from '../support/audit-rows.js';
import { clearLoginState } from '../support/login-state.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
let owner: Kysely<unknown>;

const parent = personaByKey('P-A1-one').email;
const ownerEmail = personaByKey('SO-A1').email;
const inactive = personaByKey('EDGE-inactive').email;
const blocked = personaByKey('EDGE-blocked').email;
const unknown = 'nobody.qa@two-worlds.test';
const device = { platform: 1, label: 'Pixel 8', appVersion: '1.4.0' };
const wrongFor = (code: string | undefined) => (code === '000000' ? '000001' : '000000');

/** Everything a client sees except the request ID and the date. */
function visible(res: request.Response): unknown {
  const { requestId: _r, ...body } = res.body as Record<string, unknown>;
  const headers = Object.fromEntries(
    Object.entries(res.headers).filter(
      ([name]) => !['date', 'x-request-id', 'etag', 'content-length'].includes(name),
    ),
  );
  return { status: res.status, body, headers, length: Number(res.headers['content-length']) };
}

describe('QA: AUTH-02', () => {
  let t: TestApp;
  let otp: OtpService;
  const ask = (email: string, ip = '203.0.113.20') =>
    request(t.app.getHttpServer())
      .post('/v1/auth/otp')
      .set('X-Forwarded-For', ip)
      .send({ email, clientType: 1 });
  const verify = (email: string, code: string, ip = '203.0.113.20') =>
    request(t.app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .set('X-Forwarded-For', ip)
      .send({ email, code, clientType: 1, device });
  const codeFor = async (email: string, ip = '203.0.113.20') => {
    await ask(email, ip).expect(202);
    await otp.flush();
    return t.email.latest(email, 'otp')?.variables?.code as string | undefined;
  };

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
    otp = t.app.get(OtpService);
  });
  afterEach(async () => {
    await otp.flush();
    await t.close();
    delete process.env.TRUST_PROXY;
  });

  describe('brute force', () => {
    it('over 4 hours of asking from many addresses and guessing, no lock period checks more than 5 guesses', async () => {
      const checked: number[] = [];
      const lockEnds: number[] = [];
      for (let minute = 0; minute < 240; minute += 1) {
        await ask(parent, `198.51.100.${(minute % 200) + 1}`);
        for (let g = 0; g < 3; g += 1) {
          const res = await verify(
            parent,
            String(100_000 + minute * 3 + g),
            `192.0.2.${(minute % 200) + 1}`,
          );
          if (res.status === 401 && res.body.code !== 'OTP_EXPIRED')
            checked.push(t.clock.now().getTime());
          if (res.body.code === 'OTP_ATTEMPTS_EXCEEDED')
            lockEnds.push(t.clock.now().getTime() + 30 * 60_000);
        }
        t.clock.advance(61_000);
      }
      // Split the guesses at each lock end: at most 5 in each period.
      let start = 0;
      for (const end of [...lockEnds, Infinity]) {
        const inPeriod = checked.filter((at) => at >= start && at < end).length;
        expect(inPeriod).toBeLessThanOrEqual(5);
        start = end;
      }
      expect(checked.length).toBeLessThanOrEqual(5 * (lockEnds.length + 1));
      console.log(`QA: ${checked.length} guesses checked in 4 hours, ${lockEnds.length} locks`);
    }, 120_000);

    it('parallel guesses mixed with new codes from other addresses get at most 5 tries', async () => {
      await codeFor(parent);
      const calls = [
        ...Array.from({ length: 20 }, (_, i) =>
          verify(parent, String(200_000 + i), `192.0.2.${i + 1}`),
        ),
        ...Array.from({ length: 5 }, (_, i) => ask(parent, `198.51.100.${i + 50}`)),
      ];
      const results = await Promise.all(calls);
      let counted = results
        .slice(0, 20)
        .filter((r) => r.status === 401 && r.body.code !== 'OTP_EXPIRED').length;
      for (let i = 0; i < 20; i += 1) {
        const res = await verify(parent, String(300_000 + i), `192.0.2.${i + 100}`);
        if (res.status === 401 && res.body.code !== 'OTP_EXPIRED') counted += 1;
      }
      expect(counted).toBe(5);
    });
  });

  describe('answers that could tell emails apart', () => {
    it('registered, unknown, Inactive and Blocked: the same answers through the whole lock sequence', async () => {
      const runs: unknown[][] = [];
      for (const email of [parent, unknown, inactive, blocked]) {
        await clearLoginState(owner);
        const steps: unknown[] = [];
        const code = await codeFor(email);
        for (let i = 0; i < 6; i += 1) steps.push(visible(await verify(email, wrongFor(code))));
        steps.push(visible(await ask(email)));
        t.clock.advance(30 * 60_000 + 1000);
        steps.push(visible(await verify(email, wrongFor(code))));
        const fresh = await codeFor(email);
        steps.push(visible(await verify(email, wrongFor(fresh))));
        runs.push(steps);
        t.clock.advance(60 * 60_000);
      }
      expect(runs[1]).toEqual(runs[0]);
      expect(runs[2]).toEqual(runs[0]);
      expect(runs[3]).toEqual(runs[0]);
    });
  });

  // R1 (a stranger locking the person out with five wrong guesses) waits for BravyNix's decision.

  describe('what a sign-in leaves behind', () => {
    it('logs no code, token or email, and the answer is not cached', async () => {
      const code = (await codeFor(ownerEmail))!;
      await verify(ownerEmail, wrongFor(code));
      const res = await verify(ownerEmail, code).expect(200);
      await otp.flush();
      const logs = JSON.stringify(t.logs);
      const { accessToken, refreshToken } = res.body.data;
      for (const secret of [
        code,
        accessToken,
        refreshToken,
        refreshToken.slice(3, 20),
        ownerEmail,
      ]) {
        expect(logs).not.toContain(secret);
      }
      expect(res.headers['cache-control']).toMatch(/no-store/);
    });

    it('stores no refresh token, access token or code anywhere in the identity and audit tables', async () => {
      const code = (await codeFor(ownerEmail))!;
      const res = await verify(ownerEmail, code).expect(200);
      const { accessToken, refreshToken } = res.body.data;
      const dump = await dumpTables(owner, [
        'auth_sessions',
        'refresh_tokens',
        'otp_challenges',
        'mfa_challenges',
        'user_totp_factors',
      ]);
      for (const secret of [code, accessToken, refreshToken, refreshToken.slice(3)]) {
        expect(dump).not.toContain(secret);
      }
      expect(dump).not.toContain(Buffer.from(refreshToken).toString('hex'));
    });

    it('the access token carries only the documented claims', async () => {
      const code = (await codeFor(ownerEmail))!;
      const res = await verify(ownerEmail, code).expect(200);
      const [header, payload] = (res.body.data.accessToken as string)
        .split('.')
        .slice(0, 2)
        .map(
          (part) =>
            JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>,
        );
      expect(header).toEqual({ alg: 'ES256', kid: 'k1', typ: 'JWT' });
      expect(Object.keys(payload!).toSorted()).toEqual([
        'aud',
        'cli',
        'exp',
        'iat',
        'iss',
        'rol',
        'sid',
        'soc',
        'sub',
      ]);
      expect(JSON.stringify(payload)).not.toContain('@');
    });
  });
  describe('the signing key setting', () => {
    it('an RSA key in JWT_SIGNING_KEY stops the app at start, not after a code is used up', async () => {
      await t.close();
      process.env.JWT_SIGNING_KEY = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }) as string;
      try {
        let started: TestApp | undefined;
        try {
          started = await createTestApp();
        } catch {
          // Refused at start: what we want.
        }
        if (started) {
          t = started;
          otp = t.app.get(OtpService);
          const code = (await codeFor(ownerEmail))!;
          const res = await verify(ownerEmail, code);
          const { rows } = await sql<{ n: number; used: number }>`
            select (select count(*)::int from auth_sessions) as n,
                   (select count(*)::int from otp_challenges where consumed_at is not null) as used`.execute(
            owner,
          );
          console.log(
            `QA: RSA key -> login status ${res.status}, sessions ${rows[0]!.n}, codes used ${rows[0]!.used}`,
          );
          expect(res.status).not.toBe(500);
        }
      } finally {
        delete process.env.JWT_SIGNING_KEY;
      }
      if (!t) t = await createTestApp();
    });
  });
});
