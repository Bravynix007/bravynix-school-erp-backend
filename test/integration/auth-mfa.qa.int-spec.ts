import { createHash } from 'node:crypto';
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
 * QA, slice B8: attacks on the console second factor that the engineer's spec
 * does not cover. Every test starts from a clean login state, and the file
 * leaves the Super Admin's grant and status as it found them.
 */
const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const owner = personaByKey('SO-A1');
const CONSOLE = { 'X-Requested-With': 'bravynix-console' };
const cookieHeader = (setCookie: string) => setCookie.split(';')[0]!;
const from = (ip: string) => ({ 'X-Forwarded-For': ip });

describe('QA B8: console second factor', () => {
  let db: Kysely<unknown>;
  let t: TestApp;
  let auditFloor: string;

  const http = () => t.app.getHttpServer();
  const verify = (mfaToken: string, code: string, ip = '198.51.100.1') =>
    request(http()).post('/v1/auth/mfa/verify').set(from(ip)).send({ mfaToken, code });
  const enrol = (mfaToken: string, ip = '198.51.100.1') =>
    request(http()).post('/v1/auth/mfa/enrol').set(from(ip)).send({ mfaToken });
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
    await sql`update role_assignments set revoked_at = null
      where user_id = ${superAdmin.id} and role_code = 1`.execute(db);
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

  it('10 parallel wrong codes on one token: exactly 5 counted, one lock entry, and the right code is then refused', async () => {
    const { authenticator } = await signInConsole(t, superAdmin.email);
    t.clock.advance(31_000);
    const token = await mfaTokenFrom('198.51.100.2');
    const wrong = wrongFor(authenticator);
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => verify(token, wrong, `198.51.100.${10 + i}`)),
    );
    const codes = answers.map((a) => `${a.status} ${a.body.code}`).toSorted();
    expect(codes).toEqual([
      ...Array<string>(5).fill('401 MFA_INVALID'),
      ...Array<string>(5).fill('401 MFA_TOKEN_EXPIRED'),
    ]);
    const [challenge] = await rows<{ failed_tries: number }>(
      sql`select failed_tries from mfa_challenges where used_at is null`,
    );
    expect(challenge!.failed_tries).toBe(5);
    expect(await auditRows(sql`action = 'auth.mfa_locked'`)).toHaveLength(1);
    const late = await verify(token, authenticator.code(t.clock.now())).expect(401);
    expect(late.body.code).toBe('MFA_TOKEN_EXPIRED');
  });

  it('two email codes entered at once: one authenticator code still gives one session', async () => {
    const { authenticator } = await signInConsole(t, superAdmin.email);
    t.clock.advance(31_000);
    const first = await requestCode(superAdmin.email, '198.51.100.20');
    t.clock.advance(61_000);
    const second = await requestCode(superAdmin.email, '198.51.100.21');
    const started = await Promise.all(
      [first, second].map((code, i) =>
        request(http())
          .post('/v1/auth/otp/verify')
          .set(from(`198.51.100.${20 + i}`))
          .send({ email: superAdmin.email, code, clientType: 2 }),
      ),
    );
    const tokens = started
      .filter((s) => s.status === 200)
      .map((s) => s.body.data.mfaToken as string);
    const open = await rows(sql`select 1 from mfa_challenges where used_at is null`);
    console.info(
      `QA B8 parallel email codes: ${started.map((s) => `${s.status} ${s.body.code}`).join(', ')}`,
    );
    // Both codes were right, yet only one token is open at a time.
    expect(tokens).toHaveLength(1);
    expect(open).toHaveLength(1);

    const code = authenticator.code(t.clock.now());
    const answers = await Promise.all(
      tokens.map((tk, i) => verify(tk, code, `198.51.100.${30 + i}`)),
    );
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(
      await rows(
        sql`select 1 from auth_sessions where user_id = ${superAdmin.id} and ended_at is null`,
      ),
    ).toHaveLength(2);
  });

  it('keeps the secret, the token, the codes and the cookie out of logs, audit and stored rows, and out of caches', async () => {
    const started = await mfaTokenFrom('198.51.100.40');
    const enrolled = await enrol(started).expect(200);
    expect(enrolled.headers['cache-control']).toBe('no-store');
    const secret = enrolled.body.data.secret as string;
    const app = new Authenticator(secret);
    const wrong = wrongFor(app);
    await verify(started, wrong).expect(401);
    const code = app.code(t.clock.now());
    const signedIn = await verify(started, code).expect(200);
    expect(signedIn.headers['cache-control']).toBe('no-store');
    const setCookie = (signedIn.headers['set-cookie'] as unknown as string[])[0]!;
    const refreshToken = cookieHeader(setCookie).split('=')[1]!;
    const renewed = await request(http())
      .post('/v1/auth/refresh')
      .set(CONSOLE)
      .set('Cookie', cookieHeader(setCookie))
      .send({})
      .expect(200);
    expect(renewed.headers['cache-control']).toBe('no-store');

    const secrets = [secret, started, refreshToken, signedIn.body.data.accessToken as string];
    // Codes are 6 digits, so they are looked for as whole JSON strings.
    const codes = [`"${code}"`, `"${wrong}"`];
    const logs = JSON.stringify(t.logs);
    for (const value of [...secrets, ...codes]) expect(logs).not.toContain(value);

    const entries = await auditRows(sql`entity_id = ${superAdmin.id}`);
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['auth.mfa_enrol_started', 'auth.mfa_enrolled', 'auth.login']),
    );
    const audit = JSON.stringify(entries);
    for (const value of [...secrets, ...codes]) expect(audit).not.toContain(value);

    const [factor] = await rows<{ secret_ciphertext: Buffer }>(
      sql`select secret_ciphertext from user_totp_factors`,
    );
    const raw = (app as unknown as { secret: Buffer }).secret;
    expect(factor!.secret_ciphertext.includes(raw)).toBe(false);
    const stored = JSON.stringify(
      await rows(sql`select encode(token_hmac, 'hex') as h from mfa_challenges`),
    );
    expect(stored).not.toContain(createHash('sha256').update(started).digest('hex'));
    expect(stored).not.toContain(Buffer.from(started).toString('hex'));
  });

  it('a revoked Super Admin grant ends the console session at the next call and at refresh', async () => {
    const { login, cookie } = await signInConsole(t, superAdmin.email);
    await sql`update role_assignments set revoked_at = now()
      where user_id = ${superAdmin.id} and role_code = 1`.execute(db);
    try {
      const me = await request(http())
        .get('/v1/me')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(401);
      expect(me.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'admin_revoked' } });
      const res = await request(http())
        .post('/v1/auth/refresh')
        .set(CONSOLE)
        .set('Cookie', cookieHeader(cookie))
        .send({})
        .expect(401);
      expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/^bnx_refresh=;/);
    } finally {
      await sql`update role_assignments set revoked_at = null
        where user_id = ${superAdmin.id} and role_code = 1`.execute(db);
    }
  });

  it('refuses near-miss console headers and a plain form post, without using up the cookie', async () => {
    const { cookie } = await signInConsole(t, superAdmin.email);
    const send = (headers: Record<string, string>, type = 'application/json') =>
      request(http())
        .post('/v1/auth/refresh')
        .set(headers)
        .set('Content-Type', type)
        .set('Cookie', cookieHeader(cookie))
        .send(type === 'application/json' ? '{}' : '');
    // A trailing space is not a near miss: HTTP drops it before the app sees the header.
    for (const value of ['BRAVYNIX-CONSOLE', 'bravynix-console, x', 'XMLHttpRequest', '']) {
      expect((await send({ 'X-Requested-With': value })).status).toBe(403);
    }
    expect((await send({}, 'application/x-www-form-urlencoded')).status).toBe(403);
    expect((await send({}, 'text/plain')).status).toBe(403);
    await send(CONSOLE).expect(200);
  });

  it('gives the same answer to a wrong console code for a Super Admin, another person and an unknown email', async () => {
    const shapes: string[] = [];
    for (const [i, email] of [superAdmin.email, owner.email, 'nobody@two-worlds.test'].entries()) {
      const ip = `198.51.100.${50 + i}`;
      await request(http())
        .post('/v1/auth/otp')
        .set(from(ip))
        .send({ email, clientType: 2 })
        .expect(202);
      await t.app.get(OtpService).flush();
      const sent = t.email.latest(email, 'otp')?.variables?.code as string | undefined;
      const wrong = sent === '000000' ? '000001' : '000000';
      const res = await request(http())
        .post('/v1/auth/otp/verify')
        .set(from(ip))
        .send({ email, code: wrong, clientType: 2 });
      const { date: _date, etag: _etag, 'x-request-id': _id, ...headers } = res.headers;
      shapes.push(
        JSON.stringify({
          status: res.status,
          body: { ...res.body, requestId: undefined },
          headers,
        }),
      );
    }
    expect(new Set(shapes).size).toBe(1);
  });

  it('counts enrol calls toward the per-address limit', async () => {
    const token = await mfaTokenFrom('198.51.100.60');
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await enrol(token, '198.51.100.61')).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('R1 (documents the design): wrong authenticator codes are counted per token, never per person', async () => {
    const { authenticator } = await signInConsole(t, superAdmin.email);
    let wrongCodes = 0;
    for (let round = 0; round < 3; round += 1) {
      t.clock.advance(61_000);
      const token = await mfaTokenFrom(`198.51.100.${70 + round}`);
      for (let i = 0; i < 5; i += 1) {
        await verify(token, wrongFor(authenticator), `198.51.100.${80 + round}`).expect(401);
        wrongCodes += 1;
      }
    }
    t.clock.advance(61_000);
    const token = await mfaTokenFrom('198.51.100.90');
    await verify(token, authenticator.code(t.clock.now()), '198.51.100.91').expect(200);
    console.info(
      `QA B8 R1: ${wrongCodes} wrong authenticator codes in about 4 minutes, then a sign-in`,
    );
  });
});
