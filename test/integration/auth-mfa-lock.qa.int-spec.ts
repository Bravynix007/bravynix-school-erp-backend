import { Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { newId } from '../../src/common/ids/ids.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { readAuditRows } from '../support/audit-rows.js';
import { Authenticator, signInConsole } from '../support/console-session.js';
import { clearLoginState } from '../support/login-state.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/**
 * QA, slice B8 retest 1: the per-person lock on wrong authenticator codes
 * leaves the Super Admin's grant and status as it found them.
 */
const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const from = (ip: string) => ({ 'X-Forwarded-For': ip });

describe('QA B8 retest 1: the per-person authenticator lock', () => {
  let db: Kysely<unknown>;
  let t: TestApp;
  let auditFloor: string;

  const http = () => t.app.getHttpServer();
  const verify = (mfaToken: string, code: string, ip = '198.51.100.1') =>
    request(http()).post('/v1/auth/mfa/verify').set(from(ip)).send({ mfaToken, code });
  const rows = async <T = Record<string, unknown>>(query: RawBuilder<unknown>): Promise<T[]> =>
    (await query.execute(db)).rows as T[];
  /** Audit rows of this test only: IDs are time-ordered. */
  const auditRows = (where: RawBuilder<unknown>) =>
    readAuditRows<Record<string, unknown>>(db, sql`id > ${auditFloor}::uuid and ${where}`);
  const wrongFor = (app: Authenticator) => {
    const near = [-1, 0, 1].map((offset) => app.code(t.clock.now(), offset));
    return ['000000', '111111', '222222', '333333'].find((code) => !near.includes(code))!;
  };

  async function requestCode(email: string, ip: string): Promise<string> {
    await request(http())
      .post('/v1/auth/otp')
      .set(from(ip))
      .send({ email, clientType: 2 })
      .expect(202);
    await t.app.get(OtpService).flush();
    return t.email.latest(email, 'otp')!.variables!.code as string;
  }

  /** The email-code step on the console, from one address; returns the mfaToken. */
  async function mfaTokenFrom(ip: string): Promise<string> {
    const code = await requestCode(superAdmin.email, ip);
    const res = await request(http())
      .post('/v1/auth/otp/verify')
      .set(from(ip))
      .send({ email: superAdmin.email, code, clientType: 2 })
      .expect(200);
    return res.body.data.mfaToken as string;
  }

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    db = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(db);
  });

  afterAll(async () => {
    await clearLoginState(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(db);
    await sql`update users set locked_until = null, failed_login_count = 0`.execute(db);
    auditFloor = newId();
    process.env.TRUST_PROXY = '1';
    t = await createTestApp({ captureLogs: true });
  });

  afterEach(async () => {
    await t.app.get(OtpService).flush();
    await t.close();
    delete process.env.TRUST_PROXY;
  });

  let ipSeq = 0;
  const nextIp = () => `203.0.113.${(ipSeq++ % 250) + 1}`;
  /** A new token from a new address, a minute after the last one. */
  const freshToken = async () => {
    t.clock.advance(61_000);
    return mfaTokenFrom(nextIp());
  };
  const wrongCodes = async (token: string, app: Authenticator, n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const res = await verify(token, wrongFor(app), nextIp());
      out.push(`${res.status} ${res.body.code}`);
    }
    return out;
  };
  const lockMails = () => t.email.all().filter((m) => m.template === 'authenticator-lockout');
  const lockedUntil = async () =>
    (await rows<{ locked_until: Date | null }>(sql`select locked_until from user_totp_factors`))[0]!
      .locked_until;

  it('10 parallel wrong codes after 8: one 401, one 423, the rest expired; one lock, one audit entry, one mail', async () => {
    const { authenticator: app } = await signInConsole(t, superAdmin.email);
    await wrongCodes(await freshToken(), app, 5);
    const token = await freshToken();
    await wrongCodes(token, app, 3);
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => verify(token, wrongFor(app), nextIp())),
    );
    expect(answers.map((a) => `${a.status} ${a.body.code}`).toSorted()).toEqual([
      '401 MFA_INVALID',
      ...Array<string>(8).fill('401 MFA_TOKEN_EXPIRED'),
      '423 AUTH_LOCKED',
    ]);
    expect(answers.find((a) => a.status === 423)!.headers['retry-after']).toBe('86400');
    expect(await auditRows(sql`action = 'auth.mfa_account_locked'`)).toHaveLength(1);
    await t.app.get(OtpService).flush();
    const mails = lockMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe(superAdmin.email);
    const text = JSON.stringify(mails[0]);
    expect(text).not.toMatch(/\b\d{6}\b/);
    expect(text).not.toContain('203.0.113.');
  });

  it('the lock holds for 24 hours at the email step, then a normal sign-in works', async () => {
    const { authenticator: app } = await signInConsole(t, superAdmin.email);
    await wrongCodes(await freshToken(), app, 5);
    expect((await wrongCodes(await freshToken(), app, 5)).at(-1)).toBe('423 AUTH_LOCKED');
    const lockedAt = t.clock.now().getTime();

    t.clock.advance(lockedAt + 24 * 3600_000 - 120_000 - t.clock.now().getTime());
    const ip = nextIp();
    const code = await requestCode(superAdmin.email, ip);
    const late = await request(http())
      .post('/v1/auth/otp/verify')
      .set(from(ip))
      .send({ email: superAdmin.email, code, clientType: 2 })
      .expect(423);
    expect(late.body.code).toBe('AUTH_LOCKED');
    expect(Number(late.headers['retry-after'])).toBeLessThanOrEqual(120);
    expect(late.body.data?.mfaToken).toBeUndefined();

    t.clock.advance(121_000);
    const token = await mfaTokenFrom(nextIp());
    await verify(token, app.code(t.clock.now()), nextIp()).expect(200);
  });

  it('a right code racing the tenth wrong one: never both a session and a lock', async () => {
    const { authenticator: app } = await signInConsole(t, superAdmin.email);
    for (let run = 0; run < 5; run += 1) {
      t.clock.advance(16 * 60_000);
      await sql`update user_totp_factors set wrong_codes = 9, wrong_since = ${t.clock.now()},
        locked_until = null`.execute(db);
      const token = await mfaTokenFrom(nextIp());
      const sessionsBefore = (await rows(sql`select 1 from auth_sessions`)).length;
      const [right, wrong] = await Promise.all([
        verify(token, app.code(t.clock.now()), nextIp()),
        verify(token, wrongFor(app), nextIp()),
      ]);
      const sessionsAfter = (await rows(sql`select 1 from auth_sessions`)).length;
      const locked = await lockedUntil();
      if (right.status === 200) {
        expect(wrong.body.code).toBe('MFA_TOKEN_EXPIRED');
        expect(locked).toBeNull();
        expect(sessionsAfter).toBe(sessionsBefore + 1);
      } else {
        expect(wrong.status).toBe(423);
        expect(right.body.code).toBe('MFA_TOKEN_EXPIRED');
        expect(locked).not.toBeNull();
        expect(sessionsAfter).toBe(sessionsBefore);
      }
      console.info(`QA B8 lock race ${run}: right ${right.status}, wrong ${wrong.status}`);
    }
  });

  it('observation: the count is a fixed window from the first wrong code, so a burst across its end is not locked', async () => {
    const { authenticator: app } = await signInConsole(t, superAdmin.email);
    const start = t.clock.now().getTime();
    const answers = await wrongCodes(await freshToken(), app, 1);
    t.clock.advance(start + 24 * 3600_000 - 5 * 60_000 - t.clock.now().getTime());
    const burstStart = t.clock.now().getTime();
    answers.push(...(await wrongCodes(await freshToken(), app, 5)));
    answers.push(...(await wrongCodes(await freshToken(), app, 3)));
    t.clock.advance(start + 24 * 3600_000 + 1000 - t.clock.now().getTime());
    for (const n of [5, 4]) answers.push(...(await wrongCodes(await freshToken(), app, n)));
    const burst = answers.length - 1;
    const minutes = Math.round((t.clock.now().getTime() - burstStart) / 60_000);
    expect(answers.filter((a) => a.startsWith('423'))).toHaveLength(0);
    console.info(`QA B8 window: ${burst} wrong codes in about ${minutes} minutes, no lock`);
  });
});
