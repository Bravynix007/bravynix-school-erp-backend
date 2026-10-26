import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { createPool, DatabaseService } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpHasher } from '../../src/platform/identity/otp-hasher.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { createScratchSociety, removeScratchSocieties } from '../support/scratch-society.js';
import { clearLoginState } from '../support/login-state.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const secret = process.env.OTP_HMAC_SECRET!;

let owner: Kysely<unknown>;

const registered = personaByKey('P-A1-one').email;
const pending = personaByKey('EDGE-pending').email;
const blocked = personaByKey('EDGE-blocked').email;
const inactive = personaByKey('EDGE-inactive').email;
const superAdmin = personaByKey('SA1').email;
const teacher = personaByKey('T-A1-assigned').email;

/** An address inside one IPv6 /64. */
const inside = (n: number) => `2001:db8:7:7::${n.toString(16)}`;

/** The body without the fields that differ per request. */
function shape(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = body;
  return rest;
}

const challenges = async (email: string) =>
  (
    await sql<{
      user_id: string | null;
      code_hmac: Buffer | null;
      email_hmac: Buffer;
      expires_at: Date;
      created_at: Date;
      superseded_at: Date | null;
      request_ip: string | null;
      purpose: number;
    }>`select user_id, code_hmac, email_hmac, expires_at, created_at, superseded_at, request_ip::text, purpose
       from otp_challenges where email_hmac = ${new OtpHasher(secret).email(email)} order by created_at`.execute(
      owner,
    )
  ).rows;

describe('AUTH-01 request a login code', () => {
  let t: TestApp;
  let otp: OtpService;
  const post = (body: Record<string, unknown>) =>
    request(t.app.getHttpServer()).post('/v1/auth/otp').send(body);
  const mobile = (email: string) => post({ email, clientType: 1 });
  /** A request that reached the API through one trusted proxy from this address. */
  const from = (ip: string, email = registered) =>
    post({ email, clientType: 1 }).set('X-Forwarded-For', ip);
  const sent = async (email: string) => {
    await otp.flush();
    return t.email.latest(email, 'otp');
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
    await sql`update users set locked_until = null`.execute(owner);
    t = await createTestApp();
    otp = t.app.get(OtpService);
  });

  afterEach(async () => {
    await t.close();
  });

  describe('the answer', () => {
    it('is 202 with the life of the code, and emails a six-digit code', async () => {
      const res = await mobile(registered).expect(202);
      expect(res.body).toMatchObject({
        success: true,
        statusCode: 202,
        code: 'OTP_SENT_IF_REGISTERED',
        message: 'If this email is registered, a code has been sent',
        data: { resendAfterSeconds: 60, expiresInSeconds: 600 },
      });
      const mail = await sent(registered);
      expect(mail?.variables?.code).toMatch(/^\d{6}$/);
      expect(mail?.text).toContain(mail!.variables!.code!);
      expect(t.email.count(registered)).toBe(1);
    });

    it('is exactly the same for an email with no account, but no mail is sent', async () => {
      const real = await mobile(registered).expect(202);
      const unknown = await mobile('nobody@two-worlds.test').expect(202);
      expect(shape(unknown.body)).toEqual(shape(real.body));
      await otp.flush();
      expect(t.email.count('nobody@two-worlds.test')).toBe(0);
    });

    it('is the same for an Inactive account, and no mail is sent', async () => {
      const real = await mobile(registered).expect(202);
      const res = await mobile(inactive).expect(202);
      expect(shape(res.body)).toEqual(shape(real.body));
      await otp.flush();
      expect(t.email.count(inactive)).toBe(0);
    });

    it('sends a code to a Pending account and to a Blocked one (the block shows when the code is used)', async () => {
      await mobile(pending).expect(202);
      await mobile(blocked).expect(202);
      expect((await sent(pending))?.variables?.code).toMatch(/^\d{6}$/);
      expect((await sent(blocked))?.variables?.code).toMatch(/^\d{6}$/);
    });

    it('treats the email without regard to case or spaces', async () => {
      await mobile(`  ${registered.toUpperCase()} `).expect(202);
      expect((await sent(registered))?.variables?.code).toMatch(/^\d{6}$/);
    });

    it('does not wait for the mail to be sent', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(t.email, 'send').mockImplementation(() => gate);
      // Returns while the send is still pending: the time taken tells nothing about the account.
      await mobile(registered).expect(202);
      release();
      await otp.flush();
    });
  });

  describe('what is stored', () => {
    it('keeps a keyed hash of the email and the code, never the address or the code', async () => {
      await mobile(registered).expect(202);
      const mail = await sent(registered);
      const [row] = await challenges(registered);
      expect(row?.email_hmac).toHaveLength(32);
      expect(row?.code_hmac).toHaveLength(32);
      const hasher = new OtpHasher(secret);
      expect(hasher.matches(row!.code_hmac!, registered, mail!.variables!.code!)).toBe(true);
      const dump = JSON.stringify((await sql`select * from otp_challenges`.execute(owner)).rows);
      expect(dump).not.toContain(registered);
      expect(dump).not.toContain(mail!.variables!.code!);
    });

    it('stores a challenge for an unknown email too, with no account and no code', async () => {
      await mobile('nobody@two-worlds.test').expect(202);
      const [row] = await challenges('nobody@two-worlds.test');
      expect(row).toMatchObject({ user_id: null, code_hmac: null, purpose: 1 });
    });

    it('gives the code a ten-minute life, from the clock, and notes the address', async () => {
      await mobile(registered).expect(202);
      const [row] = await challenges(registered);
      expect(row!.created_at.toISOString()).toBe(t.clock.now().toISOString());
      expect(row!.expires_at.getTime() - row!.created_at.getTime()).toBe(10 * 60 * 1000);
      expect(row?.request_ip).toMatch(/127\.0\.0\.1/);
      expect(row?.user_id).toBe(personaByKey('P-A1-one').id);
    });

    it('lets a new code replace the old one', async () => {
      await mobile(registered).expect(202);
      t.clock.advance(61_000);
      await mobile(registered).expect(202);
      const rows = await challenges(registered);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.superseded_at).not.toBeNull();
      expect(rows[1]?.superseded_at).toBeNull();
      await otp.flush();
      expect(t.email.count(registered)).toBe(2);
    });
  });

  describe('the console', () => {
    it('sends a code to a Super Admin', async () => {
      await post({ email: superAdmin, clientType: 2 }).expect(202);
      expect((await sent(superAdmin))?.variables?.code).toMatch(/^\d{6}$/);
    });

    it('answers the same, and sends nothing, to anyone else', async () => {
      const real = await post({ email: superAdmin, clientType: 2 }).expect(202);
      const res = await post({ email: teacher, clientType: 2 }).expect(202);
      expect(shape(res.body)).toEqual(shape(real.body));
      await otp.flush();
      expect(t.email.count(teacher)).toBe(0);
      expect((await challenges(teacher))[0]?.user_id).toBeNull();
    });

    it('sends nothing when the Super Admin grant has been revoked', async () => {
      await sql`update role_assignments set revoked_at = now()
        where user_id = ${personaByKey('SA2').id} and role_code = 1`.execute(owner);
      try {
        await post({ email: personaByKey('SA2').email, clientType: 2 }).expect(202);
        await otp.flush();
        expect(t.email.count(personaByKey('SA2').email)).toBe(0);
      } finally {
        await sql`update role_assignments set revoked_at = null
          where user_id = ${personaByKey('SA2').id} and role_code = 1`.execute(owner);
      }
    });

    it('still lets a Super Admin ask for a code for the app', async () => {
      await mobile(superAdmin).expect(202);
      expect((await sent(superAdmin))?.variables?.code).toMatch(/^\d{6}$/);
    });
  });

  describe('limits (API design 6.2)', () => {
    it('refuses a second request within 60 seconds, with Retry-After, then allows it', async () => {
      await mobile(registered).expect(202);
      t.clock.advance(20_000);
      const res = await mobile(registered).expect(429);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: 429,
        code: 'OTP_RESEND_TOO_SOON',
      });
      expect(res.headers['retry-after']).toBe('40');
      t.clock.advance(40_000);
      await mobile(registered).expect(202);
    });

    it('refuses the fourth request in 15 minutes, then allows it when the window has moved on', async () => {
      for (let i = 0; i < 3; i += 1) {
        await mobile(registered).expect(202);
        t.clock.advance(61_000);
      }
      const res = await mobile(registered).expect(429);
      expect(res.body.code).toBe('OTP_REQUEST_LIMIT');
      const wait = Number(res.headers['retry-after']);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(900);
      t.clock.advance(wait * 1000);
      await mobile(registered).expect(202);
    });

    it('counts an unknown email exactly the same way', async () => {
      const email = 'nobody@two-worlds.test';
      await mobile(email).expect(202);
      const tooSoon = await mobile(email).expect(429);
      expect(tooSoon.body.code).toBe('OTP_RESEND_TOO_SOON');
      for (let i = 0; i < 2; i += 1) {
        t.clock.advance(61_000);
        await mobile(email).expect(202);
      }
      t.clock.advance(61_000);
      expect((await mobile(email).expect(429)).body.code).toBe('OTP_REQUEST_LIMIT');
    });

    it('does not count refused requests, so a hammering client cannot extend its own wait', async () => {
      await mobile(registered).expect(202);
      for (let i = 0; i < 5; i += 1) await mobile(registered).expect(429);
      t.clock.advance(60_000);
      await mobile(registered).expect(202);
    });

    it('lets only one of two simultaneous requests for an email through', async () => {
      const [a, b] = await Promise.all([mobile(registered), mobile(registered)]);
      expect([a.status, b.status].toSorted()).toEqual([202, 429]);
      expect(await challenges(registered)).toHaveLength(1);
    });

    it('refuses the 21st request from one address in a minute (RATE_LIMITED), then allows it', async () => {
      for (let i = 0; i < 20; i += 1) await mobile(`person${i}@two-worlds.test`).expect(202);
      const res = await mobile('person99@two-worlds.test').expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      t.clock.advance(61_000);
      await mobile('person99@two-worlds.test').expect(202);
    });

    it('holds the limit under parallel calls from one address', async () => {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => mobile(`parallel${i}@two-worlds.test`)),
      );
      const limited = results.filter((res) => res.body.code === 'RATE_LIMITED');
      expect(results.filter((res) => res.status === 202)).toHaveLength(20);
      expect(limited).toHaveLength(20);
    });

    it('keeps one counter row per address per minute, however large the burst', async () => {
      await Promise.all(Array.from({ length: 30 }, () => mobile(registered)));
      const { rows } = await sql<{ calls: number }>`select calls from public_call_counters`.execute(
        owner,
      );
      expect(rows).toEqual([{ calls: 30 }]);
    });

    it('tells the caller to wait until the end of the minute', async () => {
      t.clock.set('2026-10-25T10:00:25.000Z');
      for (let i = 0; i < 20; i += 1) await mobile(`person${i}@two-worlds.test`).expect(202);
      const res = await mobile('person99@two-worlds.test').expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBe('35');
      t.clock.set('2026-10-25T10:01:00.000Z');
      await mobile('person99@two-worlds.test').expect(202);
    });

    it('counts refused calls too, so one address cannot hammer one email for free', async () => {
      await mobile(registered).expect(202);
      for (let i = 0; i < 19; i += 1) {
        expect((await mobile(registered).expect(429)).body.code).toBe('OTP_RESEND_TOO_SOON');
      }
      const res = await mobile(registered).expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(await challenges(registered)).toHaveLength(1);
      // Refused-for-rate calls are counted as well, so the address stays limited while it keeps calling.
      t.clock.advance(30_000);
      expect((await mobile(registered).expect(429)).body.code).toBe('RATE_LIMITED');
      t.clock.advance(61_000);
      await mobile(registered).expect(202);
    });

    it('answers at once, as too soon, when another request for the email holds the lock', async () => {
      const key = new OtpHasher(secret).email(registered).toString('hex');
      await owner.transaction().execute(async (held) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(held);
        const started = Date.now();
        const res = await mobile(registered).expect(429);
        expect(Date.now() - started).toBeLessThan(1500);
        expect(res.body.code).toBe('OTP_RESEND_TOO_SOON');
        expect(res.headers['retry-after']).toBe('60');
      });
      expect(await challenges(registered)).toHaveLength(0);
      await mobile(registered).expect(202);
    });

    it('refuses a locked account with 423 and Retry-After', async () => {
      const until = new Date(t.clock.now().getTime() + 25 * 60_000);
      await sql`update users set locked_until = ${until} where email = ${registered}`.execute(
        owner,
      );
      const res = await mobile(registered).expect(423);
      expect(res.body).toMatchObject({ statusCode: 423, code: 'AUTH_LOCKED' });
      expect(res.headers['retry-after']).toBe('1500');
      expect(await challenges(registered)).toHaveLength(0);
    });

    it('locks an email with no account the same way, and the lock ends on time', async () => {
      const email = 'nobody@two-worlds.test';
      await mobile(email).expect(202);
      const until = new Date(t.clock.now().getTime() + 25 * 60_000);
      await sql`update otp_challenges set locked_until = ${until}
        where email_hmac = ${new OtpHasher(secret).email(email)}`.execute(owner);
      const res = await mobile(email).expect(423);
      expect(res.body.code).toBe('AUTH_LOCKED');
      expect(res.headers['retry-after']).toBe('1500');
      t.clock.advance(25 * 60_000 + 1000);
      await mobile(email).expect(202);
    });
  });

  describe('someone else asking for a person’s code (behind one proxy)', () => {
    beforeEach(async () => {
      await t.close();
      process.env.TRUST_PROXY = '1';
      t = await createTestApp();
      otp = t.app.get(OtpService);
    });

    afterEach(() => {
      delete process.env.TRUST_PROXY;
    });

    it('cannot use up the person’s three requests by asking from another address', async () => {
      for (let i = 0; i < 3; i += 1) {
        await from('198.51.100.9').expect(202);
        t.clock.advance(61_000);
      }
      expect((await from('198.51.100.9').expect(429)).body.code).toBe('OTP_REQUEST_LIMIT');
      await from('203.0.113.20').expect(202);
    });

    it('does not cancel the person’s live code when it asks from another address', async () => {
      await from('203.0.113.20').expect(202);
      t.clock.advance(61_000);
      await from('198.51.100.9').expect(202);
      const rows = await challenges(registered);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.superseded_at)).toEqual([null, null]);
    });

    it('still replaces the live code when the same address asks again', async () => {
      await from('203.0.113.20').expect(202);
      t.clock.advance(61_000);
      await from('203.0.113.20').expect(202);
      const rows = await challenges(registered);
      expect(rows.map((row) => row.superseded_at === null)).toEqual([false, true]);
    });

    it('counts an IPv6 caller by its /64 and an IPv4-mapped caller as IPv4', async () => {
      await from('2001:db8:1:2::1', 'a@two-worlds.test').expect(202);
      await from('2001:db8:1:2:ffff::7', 'b@two-worlds.test').expect(202);
      await from('::ffff:203.0.113.9', 'c@two-worlds.test').expect(202);
      await from('203.0.113.9', 'd@two-worlds.test').expect(202);
      const { rows } = await sql<{ ip: string; calls: number }>`
        select host(ip) as ip, calls from public_call_counters order by ip`.execute(owner);
      expect(rows).toEqual([
        { ip: '2001:db8:1:2::', calls: 2 },
        { ip: '203.0.113.9', calls: 2 },
      ]);
    });

    it('treats addresses in one IPv6 /64 as one caller for the three and for replacing a code', async () => {
      for (let i = 1; i <= 3; i += 1) {
        await from(inside(i)).expect(202);
        t.clock.advance(61_000);
      }
      // A fourth address inside the same /64 is the same caller: refused at three.
      expect((await from(inside(4)).expect(429)).body.code).toBe('OTP_REQUEST_LIMIT');
      // Another network is not.
      await from('2001:db8:8:8::1').expect(202);
      // Each request from the /64 replaced the earlier code from it; the other network's stays.
      const live = (await challenges(registered)).filter((row) => row.superseded_at === null);
      expect(live).toHaveLength(2);
    });

    it('caps all addresses together at ten in 15 minutes, for registered and unknown emails alike', async () => {
      for (const email of [registered, 'nobody@two-worlds.test']) {
        for (let i = 1; i <= 10; i += 1) {
          await from(`198.51.100.${i}`, email).expect(202);
          t.clock.advance(61_000);
        }
        const res = await from('198.51.100.99', email).expect(429);
        expect(res.body.code).toBe('OTP_REQUEST_LIMIT');
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        t.clock.advance(Number(res.headers['retry-after']) * 1000);
        await from('198.51.100.99', email).expect(202);
        t.clock.advance(15 * 60_000);
      }
    });
  });

  describe('the request', () => {
    it.each([
      ['no email', { clientType: 1 }, 'email', 'REQUIRED'],
      ['an empty email', { email: '', clientType: 1 }, 'email', 'REQUIRED'],
      ['a bad email', { email: 'not-an-email', clientType: 1 }, 'email', 'INVALID_FORMAT'],
      ['a long email', { email: `${'a'.repeat(250)}@x.test`, clientType: 1 }, 'email', 'TOO_LONG'],
      ['no client type', { email: 'a@x.test' }, 'clientType', 'INVALID_TYPE'],
      ['a text client type', { email: 'a@x.test', clientType: '1' }, 'clientType', 'INVALID_TYPE'],
      [
        'an unknown client type',
        { email: 'a@x.test', clientType: 3 },
        'clientType',
        'INVALID_CODE',
      ],
      [
        'an extra field',
        { email: 'a@x.test', clientType: 1, role: 1 },
        'role',
        'FIELD_NOT_ALLOWED',
      ],
    ])('refuses %s with 400 VALIDATION_FAILED', async (_name, body, field, code) => {
      const res = await post(body as Record<string, unknown>).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field, code })]),
      );
      expect(
        await sql`select 1 from otp_challenges`.execute(owner).then((r) => r.rows),
      ).toHaveLength(0);
    });
  });

  describe('development echo', () => {
    afterEach(() => {
      process.env.OTP_DEV_ECHO = 'false';
    });

    it('is off by default: the answer never carries the code', async () => {
      const res = await mobile(registered).expect(202);
      expect(res.body.data).not.toHaveProperty('devOtp');
    });

    it('returns the code for a registered account only, when switched on', async () => {
      await t.close();
      process.env.OTP_DEV_ECHO = 'true';
      t = await createTestApp();
      otp = t.app.get(OtpService);
      const res = await mobile(registered).expect(202);
      await otp.flush();
      expect(res.body.data.devOtp).toBe(t.email.latest(registered, 'otp')!.variables!.code);
      const unknown = await mobile('nobody@two-worlds.test').expect(202);
      expect(unknown.body.data).not.toHaveProperty('devOtp');
    });
  });
});

const insertUser = (email: string, extra = sql``) =>
  sql`insert into users (email ${extra}) values (${email})`;

describe('identity tables', () => {
  let t: TestApp;
  let database: DatabaseService;
  let ownerDb: Kysely<unknown>;

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp();
    database = t.app.get(DatabaseService);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  const grant = (columns: string, values: unknown[]) =>
    sql`insert into role_assignments (${sql.raw(columns)}) values (${sql.join(values)})`.execute(
      ownerDb,
    );

  const insert = (columns: string, values: unknown[]) =>
    sql`insert into otp_challenges (${sql.raw(columns)}, email_hmac, expires_at)
      values (${sql.join(values)}, ${Buffer.alloc(32, 1)}, now())`.execute(ownerDb);

  const user = async (
    extraColumns: string,
    extraValues: unknown[],
    email = `${newId()}@two-worlds.test`,
  ) =>
    sql`insert into users (email, ${sql.raw(extraColumns)}) values (${email}, ${sql.join(extraValues)})`.execute(
      ownerDb,
    );

  describe('users', () => {
    it('requires a lower-case email with one @, and a unique one', async () => {
      await expect(insertUser('Upper@Case.test').execute(ownerDb)).rejects.toThrow(
        /ck_users_email/,
      );
      await expect(insertUser('no-at-sign').execute(ownerDb)).rejects.toThrow(/ck_users_email/);
      await expect(insertUser('a@b@c.test').execute(ownerDb)).rejects.toThrow(/ck_users_email/);
      await expect(insertUser(personaByKey('SA1').email).execute(ownerDb)).rejects.toThrow(
        /uq_users_email/,
      );
    });

    it('needs both phone columns or neither, and digits only', async () => {
      await expect(user('country_code', ['91'])).rejects.toThrow(/ck_users_phone_pair/);
      await expect(user('country_code, phone_number', ['91', '12345'])).rejects.toThrow(
        /ck_users_phone_number/,
      );
      await expect(user('country_code, phone_number', ['+91', '9999999999'])).rejects.toThrow(
        /ck_users_country_code/,
      );
      await user('country_code, phone_number', ['91', '9999999999']);
    });

    it('ties a block to its date, and limits status and language', async () => {
      await expect(user('account_status', [2])).rejects.toThrow(/ck_users_blocked/);
      await expect(user('account_status', [9])).rejects.toThrow(/ck_users_status/);
      await expect(user('preferred_language', ['fr'])).rejects.toThrow(/ck_users_language/);
      await expect(user('failed_login_count', [-1])).rejects.toThrow(/ck_users_failed_login_count/);
    });

    it('starts Pending, in English, and counts versions and update times itself', async () => {
      const email = `${newId()}@two-worlds.test`;
      await user('first_name', ['Asha'], email);
      const row = async () =>
        (
          await sql<{
            account_status: number;
            preferred_language: string;
            version: number;
            updated_at: Date;
            created_at: Date;
          }>`
            select account_status, preferred_language, version, updated_at, created_at from users where email = ${email}`.execute(
            ownerDb,
          )
        ).rows[0]!;
      const first = await row();
      expect(first).toMatchObject({ account_status: 3, preferred_language: 'en', version: 1 });
      await sql`update users set first_name = 'Asha R' where email = ${email}`.execute(ownerDb);
      const second = await row();
      expect(second.version).toBe(2);
      expect(second.updated_at.getTime()).toBeGreaterThanOrEqual(first.updated_at.getTime());
      expect(second.created_at.getTime()).toBe(first.created_at.getTime());
    });

    it('has no password column, and the app role cannot truncate it', async () => {
      const { rows } = await sql<{ column_name: string }>`
        select column_name from information_schema.columns where table_name = 'users'`.execute(
        ownerDb,
      );
      expect(rows.map((r) => r.column_name).filter((c) => /pass|mfa|totp|secret/.test(c))).toEqual(
        [],
      );
      await expect(sql`truncate users`.execute(database.db)).rejects.toThrow(/permission denied/);
    });

    it('cannot be deleted from by the app role: accounts are deactivated, not removed', async () => {
      await expect(
        sql`delete from users where email = ${personaByKey('SA1').email}`.execute(database.db),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('role_assignments', () => {
    let person: string;
    const societies: string[] = [];
    // A grant names a real Society (fk_role_assignments_society); the tenant
    // roots force row-level security even on their owner, hence Super Admin.
    const newSociety = async (): Promise<string> => {
      const id = newId();
      await createScratchSociety(ownerDb, id);
      societies.push(id);
      return id;
    };
    beforeEach(async () => {
      person = newId();
      await sql`insert into users (id, email) values (${person}, ${`${person}@two-worlds.test`})`.execute(
        ownerDb,
      );
    });
    afterEach(async () => {
      await sql`delete from role_assignments where user_id = ${person}`.execute(ownerDb);
      await removeScratchSocieties(ownerDb, societies.splice(0));
    });

    it('lets a role carry only the scope it should', async () => {
      const society = newId();
      await expect(
        grant('user_id, role_code, seat_no, society_id', [person, 1, 3, society]),
      ).rejects.toThrow(/ck_role_assignments_scope/);
      await expect(grant('user_id, role_code, society_id', [person, 2, society])).rejects.toThrow(
        /ck_role_assignments_scope/,
      );
      await expect(grant('user_id, role_code, seat_no', [person, 2, 1])).rejects.toThrow(
        /ck_role_assignments_scope/,
      );
      await expect(
        grant('user_id, role_code, society_id, seat_no', [person, 3, society, 1]),
      ).rejects.toThrow(/ck_role_assignments_scope/);
      await expect(grant('user_id, role_code, seat_no', [person, 4, 1])).rejects.toThrow(
        /ck_role_assignments_role/,
      );
      await expect(grant('user_id, role_code, seat_no', [person, 1, 4])).rejects.toThrow(
        /ck_role_assignments_seat/,
      );
    });

    it('allows at most 3 active Super Admins, and a revoked seat can be used again', async () => {
      // The seed holds seats 1 and 2; seat 3 is free.
      await grant('user_id, role_code, seat_no', [person, 1, 3]);
      const fourth = newId();
      await sql`insert into users (id, email) values (${fourth}, ${`${fourth}@two-worlds.test`})`.execute(
        ownerDb,
      );
      await expect(grant('user_id, role_code, seat_no', [fourth, 1, 3])).rejects.toThrow(
        /uq_role_assignments_super_admin_seat/,
      );
      await expect(grant('user_id, role_code, seat_no', [fourth, 1, 4])).rejects.toThrow(
        /ck_role_assignments_seat/,
      );
      await sql`update role_assignments set revoked_at = now() where user_id = ${person}`.execute(
        ownerDb,
      );
      await grant('user_id, role_code, seat_no', [fourth, 1, 3]);
      await sql`delete from role_assignments where user_id = ${fourth}`.execute(ownerDb);
      await sql`delete from users where id = ${fourth}`.execute(ownerDb);
    });

    it('allows at most 3 Society Owners per Society, and the same number in another Society', async () => {
      const society = await newSociety();
      const others = [newId(), newId(), newId()];
      for (const [i, other] of others.entries()) {
        await sql`insert into users (id, email) values (${other}, ${`${other}@two-worlds.test`})`.execute(
          ownerDb,
        );
        await grant('user_id, role_code, society_id, seat_no', [other, 2, society, i + 1]);
      }
      await expect(
        grant('user_id, role_code, society_id, seat_no', [person, 2, society, 1]),
      ).rejects.toThrow(/uq_role_assignments_owner_seat/);
      await grant('user_id, role_code, society_id, seat_no', [person, 2, await newSociety(), 1]);
      for (const other of others) {
        await sql`delete from role_assignments where user_id = ${other}`.execute(ownerDb);
        await sql`delete from users where id = ${other}`.execute(ownerDb);
      }
    });

    it('refuses the same active grant twice', async () => {
      const society = await newSociety();
      await grant('user_id, role_code, society_id, seat_no', [person, 2, society, 2]);
      await expect(
        grant('user_id, role_code, society_id, seat_no', [person, 2, society, 3]),
      ).rejects.toThrow(/uq_role_assignments_active_grant/);
    });

    it('ties the revoke columns together, and never lets the app role delete a grant', async () => {
      await grant('user_id, role_code, seat_no', [person, 1, 3]);
      await expect(
        sql`update role_assignments set revoke_reason = 'x' where user_id = ${person}`.execute(
          ownerDb,
        ),
      ).rejects.toThrow(/ck_role_assignments_revoke/);
      await expect(
        sql`delete from role_assignments where user_id = ${person}`.execute(database.db),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('otp_challenges', () => {
    it('is swept by a platform job, not by the app role', async () => {
      await expect(sql`delete from otp_challenges`.execute(database.db)).rejects.toThrow(
        /permission denied/,
      );
    });

    it('needs an account exactly when it has a code, and fixed-size hashes', async () => {
      await expect(insert('user_id', [personaByKey('SA1').id])).rejects.toThrow(
        /ck_otp_challenges_account/,
      );
      await expect(insert('code_hmac', [Buffer.alloc(32, 2)])).rejects.toThrow(
        /ck_otp_challenges_account/,
      );
      await expect(
        sql`insert into otp_challenges (email_hmac, expires_at) values (${Buffer.alloc(5)}, now())`.execute(
          ownerDb,
        ),
      ).rejects.toThrow(/ck_otp_challenges_email_hmac/);
      await expect(insert('attempt_count', [6])).rejects.toThrow(/ck_otp_challenges_attempts/);
      await expect(insert('purpose', [3])).rejects.toThrow(/ck_otp_challenges_purpose/);
    });
  });
});

describe('public_call_counters', () => {
  it('lets the app role count and read but not remove', async () => {
    const t = await createTestApp();
    try {
      const { db } = t.app.get(DatabaseService);
      await sql`insert into public_call_counters (ip, window_start, calls)
        values ('203.0.113.50', now(), 1) on conflict (scope, ip, window_start) do update set calls = public_call_counters.calls + 1`.execute(
        db,
      );
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from public_call_counters where ip = '203.0.113.50'`.execute(db);
      expect(rows[0]?.n).toBeGreaterThan(0);
      await expect(sql`delete from public_call_counters`.execute(db)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`truncate public_call_counters`.execute(db)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await t.close();
    }
  });
});
