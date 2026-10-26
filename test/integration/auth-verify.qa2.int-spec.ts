// QA round 2 for Phase 1 B3 (AUTH-02): the 24-hour lock at the third lockout
// in a day, the lockout mail, and parity for unknown, Inactive and Blocked emails.
import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { BackgroundMailer } from '../../src/platform/identity/background-mailer.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { clearLoginState } from '../support/login-state.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
let owner: Kysely<unknown>;
const parent = personaByKey('P-A1-one').email;
const inactive = personaByKey('EDGE-inactive').email;
const blocked = personaByKey('EDGE-blocked').email;
const unknown = 'nobody.qa2@two-worlds.test';
const device = { platform: 1, label: 'Pixel 8', appVersion: '1.4.0' };
const HOUR = 3600_000;

function visible(res: request.Response): unknown {
  const { requestId: _r, ...body } = res.body as Record<string, unknown>;
  const headers = Object.fromEntries(
    Object.entries(res.headers).filter(
      ([name]) => !['date', 'x-request-id', 'etag', 'content-length'].includes(name),
    ),
  );
  return { status: res.status, body, headers, length: Number(res.headers['content-length']) };
}

async function clean(): Promise<void> {
  await clearLoginState(owner);
  await sql`update users set locked_until = null, failed_login_count = 0`.execute(owner);
}

describe('QA round 2: AUTH-02 repeated lockouts', () => {
  let t: TestApp;
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
  const flush = async () => {
    await t.app.get(OtpService).flush();
    await t.app.get(BackgroundMailer).flush();
  };
  const lockoutMails = (email: string) =>
    t.email.all().filter((m) => m.to === email && m.template === 'login-lockout');
  /** Asks for a code and sends five wrong ones; returns what each call answered. */
  const lockOnce = async (email: string, ip = '198.51.100.9') => {
    const steps = [visible(await ask(email, ip))];
    for (let i = 0; i < 5; i += 1) steps.push(visible(await verify(email, '000000', ip)));
    await flush();
    return steps;
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
    await clean();
    process.env.TRUST_PROXY = '1';
    t = await createTestApp();
  });
  afterEach(async () => {
    await flush();
    await t.close();
    delete process.env.TRUST_PROXY;
  });

  it('30 min, 30 min, then 24 hours; every answer the same for registered, unknown, Inactive and Blocked', async () => {
    const runs: unknown[][] = [];
    const mails: number[] = [];
    for (const email of [parent, unknown, inactive, blocked]) {
      await clean();
      const steps: unknown[] = [];
      for (let round = 0; round < 3; round += 1) {
        steps.push(...(await lockOnce(email)));
        steps.push(visible(await verify(email, '000000')));
        steps.push(visible(await ask(email, '203.0.113.77')));
        t.clock.advance(30 * 60_000 + 1000);
      }
      // The third lock is 24 hours: still locked 23 hours later, free after 24.
      t.clock.advance(23 * HOUR - 30 * 60_000);
      steps.push(visible(await ask(email, '203.0.113.78')));
      t.clock.advance(HOUR);
      steps.push(visible(await ask(email, '203.0.113.79')));
      steps.push(visible(await verify(email, '000000', '203.0.113.79')));
      await flush();
      runs.push(steps);
      mails.push(lockoutMails(email).length);
      t.clock.advance(48 * HOUR);
    }
    const retryAfters = (runs[0] as { status: number; headers: Record<string, string> }[])
      .filter((s) => s.headers['retry-after'] && s.status !== 202)
      .map((s) => s.headers['retry-after']);
    console.log(`QA: Retry-After along the way: ${retryAfters.join(', ')}`);
    expect(retryAfters).toContain('86400');
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(runs[3]).toEqual(runs[0]);
    // Registered and Blocked people are told each time; unknown and Inactive get nothing.
    expect(mails).toEqual([3, 0, 0, 3]);
  });

  it('the mail names the lock length only: no code, no address, no caller', async () => {
    for (let round = 0; round < 3; round += 1) {
      await lockOnce(parent, '198.51.100.9');
      t.clock.advance(30 * 60_000 + 1000);
    }
    const sent = lockoutMails(parent);
    expect(sent.map((m) => m.variables?.duration)).toEqual([
      '30 minutes',
      '30 minutes',
      '24 hours',
    ]);
    for (const mail of sent) {
      const text = JSON.stringify(mail);
      expect(text).not.toMatch(/198\.51\.100\.9|\b\d{6}\b/);
    }
  });

  it('lockouts more than 24 hours old do not count; the count is per email', async () => {
    await lockOnce(parent);
    t.clock.advance(30 * 60_000 + 1000);
    await lockOnce(parent);
    t.clock.advance(24 * HOUR);
    const steps = await lockOnce(parent);
    expect((steps[5] as { headers: Record<string, string> }).headers['retry-after']).toBe('1800');
    // Another email's lockouts do not add to this one.
    t.clock.advance(30 * 60_000 + 1000);
    await lockOnce(unknown);
    await lockOnce('other.qa2@two-worlds.test');
    const next = await lockOnce(parent);
    expect((next[5] as { headers: Record<string, string> }).headers['retry-after']).toBe('1800');
  });

  it('a 24-hour lock holds when every challenge and the account lock are cleared', async () => {
    for (let round = 0; round < 3; round += 1) {
      await lockOnce(parent);
      t.clock.advance(30 * 60_000 + 1000);
    }
    await sql`delete from otp_challenges`.execute(owner);
    await sql`update users set locked_until = null`.execute(owner);
    const res = await ask(parent, '203.0.113.80');
    expect(res.status).toBe(423);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(22 * 3600);
  });

  it('parallel fifth guesses make one lockout, not several', async () => {
    await ask(parent, '198.51.100.9');
    for (let i = 0; i < 4; i += 1) await verify(parent, '000000', '198.51.100.9');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => verify(parent, '000000', `192.0.2.${i + 1}`)),
    );
    const { rows } = await sql<{
      n: number;
    }>`select count(*)::int as n from login_lockouts`.execute(owner);
    expect(rows[0]!.n).toBe(1);
    await flush();
    expect(lockoutMails(parent)).toHaveLength(1);
  });

  it('the app role can only insert and read lockouts', async () => {
    const { rows } = await sql<{ p: string; ok: boolean }>`
      select p, has_table_privilege('erp_app', 'login_lockouts', p) as ok
      from unnest(array['INSERT','SELECT','UPDATE','DELETE','TRUNCATE']) as p`.execute(owner);
    expect(Object.fromEntries(rows.map((r) => [r.p, r.ok]))).toEqual({
      INSERT: true,
      SELECT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    });
  });

  it('R1 today: a stranger alone locks a person out for a day with 15 guesses', async () => {
    for (let round = 0; round < 3; round += 1) {
      await lockOnce(parent, '198.51.100.9');
      t.clock.advance(30 * 60_000 + 1000);
    }
    const res = await ask(parent, '203.0.113.20');
    console.log(
      `QA R1: the person asks from their own network -> ${res.status}, Retry-After ${res.headers['retry-after']}`,
    );
    expect(res.status).toBe(423);
  });
});
