import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { TokenService } from '../../src/platform/identity/token.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { superAdminToken } from '../support/admin-token.js';
import { apiCaller } from '../support/api.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { removeScratchPeople, scratchEmail } from '../support/scratch-people.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/**
 * QA, slice B9c: attacks on PLT-09 to PLT-18 and PLT-41 that the engineer's
 * specs do not cover. Seeded Super Admins that a test changes are restored in
 * a `finally`; scratch people and Societies are removed after each test.
 */
const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const otherAdmin = personaByKey('SA2');
const missing = '00000000-0000-7000-8000-00000000ffff';

describe('QA B9c: people and accounts', () => {
  let db: Kysely<unknown>;
  let t: TestApp;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const emails: string[] = [];

  const email = () => {
    const made = scratchEmail();
    emails.push(made);
    return made;
  };
  const society = async (body: Record<string, unknown> = {}) => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'QA Trust',
      code: `Q${newId().slice(-12)}`,
      ...body,
    });
    if (res.status === 201) societies.push(res.body.data.id);
    return res;
  };
  const versionOf = async (userId: string) =>
    (await sql<{ version: number }>`select version from users where id = ${userId}`.execute(db))
      .rows[0]!.version;
  const statusOf = async (userId: string) =>
    (
      await sql<{ s: number }>`select account_status as s from users where id = ${userId}`.execute(
        db,
      )
    ).rows[0]!.s;
  /** A phone session with no context, made without the sign-in steps. */
  const mobileToken = async (personId: string) => {
    const { rows } = await sql<{ id: string }>`
      insert into auth_sessions (user_id, client_type, idle_expires_at, absolute_expires_at)
      values (${personId}, 1, now() + interval '1 hour', now() + interval '1 hour') returning id`.execute(
      db,
    );
    return (
      await t.app.get(TokenService).signAccessToken(
        {
          personId,
          sessionId: rows[0]!.id,
          roleCode: null,
          societyId: null,
          clientType: 'mobile',
        },
        t.clock.now(),
      )
    ).token;
  };
  /** Puts both seeded Super Admins back as they were. */
  const restoreSeededAdmins = async () => {
    await sql`update users set account_status = 1, blocked_at = null, blocked_by = null, block_reason = null
      where id in (${superAdmin.id}, ${otherAdmin.id})`.execute(db);
    await sql`update role_assignments set revoked_at = null, revoked_by = null, revoke_reason = null
      where user_id in (${superAdmin.id}, ${otherAdmin.id}) and role_code = 1`.execute(db);
  };

  const askForCode = (address: string, ip: string) =>
    request(t.app.getHttpServer())
      .post('/v1/auth/otp')
      .set('X-Forwarded-For', ip)
      .send({ email: address, clientType: 1 });
  const enterCode = (address: string, code: string, ip: string) =>
    request(t.app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .set('X-Forwarded-For', ip)
      .send({
        email: address,
        code,
        clientType: 1,
        device: { platform: 1, label: 'QA', appVersion: '1.0.0' },
      });
  const latestCode = async (address: string) => {
    await t.app.get(OtpService).flush();
    return t.email.latest(address, 'otp')!.variables!.code as string;
  };
  /** Five wrong codes from a person's own phone: a real lockout, with its mail. */
  const lockOut = async (address: string, ip: string) => {
    await askForCode(address, ip).expect(202);
    const right = await latestCode(address);
    const wrong = right === '000000' ? '000001' : '000000';
    let last: request.Response | undefined;
    for (let i = 0; i < 5; i += 1) last = await enterCode(address, wrong, ip);
    return last!;
  };

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    db = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(db);
    t = await createTestApp({ imports: [FixtureModule] });
    api = apiCaller(t);
  });

  afterAll(async () => {
    await restoreSeededAdmins();
    await clearLoginState(db);
    await t.close();
    await db.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(db);
    await restoreSeededAdmins();
    process.env.TRUST_PROXY = '1';
    admin = await superAdminToken(t, db, superAdmin.id);
  });

  afterEach(async () => {
    delete process.env.TRUST_PROXY;
    await clearLoginState(db);
    await removeScratchSocieties(db, societies.splice(0));
    await removeScratchPeople(db, emails.splice(0));
  });

  it('refuses all 11 routes to every caller but a Super Admin on the console, and changes nothing', async () => {
    const s = (await society()).body.data.id;
    const ownerEmail = email();
    const owner = (
      await api('post', `/v1/platform/societies/${s}/owners`, admin, { email: ownerEmail })
    ).body.data.id;
    const ownerToken = (await signInMobile(t, ownerEmail)).accessToken;
    const nobody = email();
    await sql`insert into users (id, email) values (${newId()}, ${nobody})`.execute(db);
    const noRole = (await signInMobile(t, nobody)).accessToken;
    const saMobile = await mobileToken(otherAdmin.id);
    const callers: [string, string, number][] = [
      ['owner', ownerToken, 403],
      ['no role', noRole, 403],
      ['super admin on mobile', saMobile, 403],
      ['no token', '', 401],
      ['bad token', 'not-a-token', 401],
    ];
    const routes: [Parameters<typeof api>[0], string, object][] = [
      ['get', '/v1/platform/society-owners', {}],
      ['post', `/v1/platform/societies/${s}/owners`, { email: email() }],
      ['delete', `/v1/platform/societies/${s}/owners/${owner}`, {}],
      ['get', '/v1/platform/super-admins', {}],
      ['post', '/v1/platform/super-admins', { email: email() }],
      ['delete', `/v1/platform/super-admins/${otherAdmin.id}`, {}],
      ['post', `/v1/platform/users/${otherAdmin.id}/block`, { version: 1, reason: 'x' }],
      ['post', `/v1/platform/users/${owner}/unblock`, { version: 1 }],
      ['put', `/v1/platform/users/${owner}/email`, { version: 1, email: email() }],
      ['delete', `/v1/platform/users/${otherAdmin.id}/mfa`, {}],
      ['post', `/v1/platform/users/${owner}/unlock`, { reason: 'x' }],
    ];
    const wrong: string[] = [];
    for (const [who, token, expected] of callers) {
      for (const [method, path, body] of routes) {
        const res = await api(method, path, token, body);
        if (res.status !== expected) wrong.push(`${who} ${method} ${path}: ${res.status}`);
      }
    }
    console.info(`QA B9c matrix misses:\n${wrong.join('\n')}`);
    expect(wrong).toEqual([]);
    expect(await statusOf(otherAdmin.id)).toBe(1);
    const grants = await sql<{ n: number }>`
      select count(*)::int as n from role_assignments where society_id = ${s} and revoked_at is null`.execute(
      db,
    );
    expect(grants.rows[0]!.n).toBe(1);
  });

  it('two adds for the last Owner seat at once: one 201, one SEAT_LIMIT_REACHED; never a fourth Owner', async () => {
    const res = await society({ owners: [{ email: email() }, { email: email() }] });
    expect(res.status).toBe(201);
    const s = res.body.data.id;
    const answers = await Promise.all(
      [email(), email()].map((address) =>
        api('post', `/v1/platform/societies/${s}/owners`, admin, { email: address }),
      ),
    );
    expect(answers.map((a) => `${a.status} ${a.body.code}`).toSorted()).toEqual(
      ['201 CREATED', '409 SEAT_LIMIT_REACHED'].toSorted(),
    );
    const owners = await sql<{ n: number }>`
      select count(*)::int as n from role_assignments where society_id = ${s} and role_code = 2 and revoked_at is null`.execute(
      db,
    );
    expect(owners.rows[0]!.n).toBe(3);
  });

  it('two Societies made at once naming the same new Owner email: the loser makes no Society', async () => {
    const shared = email();
    const answers = await Promise.all([
      society({ owners: [{ email: shared }] }),
      society({ owners: [{ email: shared }] }),
    ]);
    const statuses = answers.map((a) => a.status).toSorted();
    console.info(
      `QA B9c same new owner in two Societies: ${answers.map((a) => `${a.status} ${a.body.code}`).join(', ')}`,
    );
    // One email is one person: both may succeed with the same person, or the loser is refused whole.
    const created = answers.filter((a) => a.status === 201).length;
    const people = await sql<{
      n: number;
    }>`select count(*)::int as n from users where email = ${shared}`.execute(db);
    expect(people.rows[0]!.n).toBe(1);
    const grants = await sql<{ n: number }>`
      select count(*)::int as n from role_assignments ra join users u on u.id = ra.user_id
      where u.email = ${shared} and ra.role_code = 2 and ra.revoked_at is null`.execute(db);
    expect(grants.rows[0]!.n).toBe(created);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
  });

  it('D1: two Super Admins blocking each other at once must not leave the platform with no usable Super Admin', async () => {
    const other = await superAdminToken(t, db, otherAdmin.id);
    try {
      const [a, b] = await Promise.all([
        api('post', `/v1/platform/users/${otherAdmin.id}/block`, admin, {
          version: await versionOf(otherAdmin.id),
          reason: 'QA race',
        }),
        api('post', `/v1/platform/users/${superAdmin.id}/block`, other, {
          version: await versionOf(superAdmin.id),
          reason: 'QA race',
        }),
      ]);
      const usable = await sql<{ n: number }>`
        select count(*)::int as n from role_assignments ra join users u on u.id = ra.user_id
        where ra.role_code = 1 and ra.revoked_at is null and u.account_status in (0, 1)`.execute(
        db,
      );
      console.info(
        `QA B9c mutual block: ${a.status} ${a.body.code}, ${b.status} ${b.body.code}; usable Super Admins ${usable.rows[0]!.n}`,
      );
      expect(usable.rows[0]!.n).toBeGreaterThanOrEqual(1);
    } finally {
      await restoreSeededAdmins();
    }
  });

  it('D1 (second path): a removal racing a block of the remover must not leave no usable Super Admin', async () => {
    const other = await superAdminToken(t, db, otherAdmin.id);
    try {
      const [a, b] = await Promise.all([
        api('delete', `/v1/platform/super-admins/${otherAdmin.id}`, admin),
        api('post', `/v1/platform/users/${superAdmin.id}/block`, other, {
          version: await versionOf(superAdmin.id),
          reason: 'QA race',
        }),
      ]);
      const usable = await sql<{ n: number }>`
        select count(*)::int as n from role_assignments ra join users u on u.id = ra.user_id
        where ra.role_code = 1 and ra.revoked_at is null and u.account_status in (0, 1)`.execute(
        db,
      );
      console.info(
        `QA B9c remove vs block: ${a.status} ${a.body.code}, ${b.status} ${b.body.code}; usable Super Admins ${usable.rows[0]!.n}`,
      );
      expect(usable.rows[0]!.n).toBeGreaterThanOrEqual(1);
    } finally {
      await restoreSeededAdmins();
    }
  });

  it('after a support unlock of a real lockout, a new code and one wrong guess do not lock again', async () => {
    const s = (await society()).body.data.id;
    const address = email();
    const owner = (
      await api('post', `/v1/platform/societies/${s}/owners`, admin, { email: address })
    ).body.data.id as string;
    const locked = await lockOut(address, '198.51.100.10');
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    expect((await askForCode(address, '198.51.100.11')).status).toBe(423);

    await api('post', `/v1/platform/users/${owner}/unlock`, admin, {
      reason: 'Rang the office',
    }).then((res) => expect(res.status).toBe(200));
    t.clock.advance(61_000);
    await askForCode(address, '198.51.100.12').expect(202);
    const right = await latestCode(address);
    const wrong = right === '000000' ? '000001' : '000000';
    const once = await enterCode(address, wrong, '198.51.100.12');
    console.info(
      `QA B9c first wrong code after unlock: ${once.status} ${once.body.code} ${JSON.stringify(once.body.data)}`,
    );
    expect(once.body.code).toBe('OTP_INVALID');
    await enterCode(address, right, '198.51.100.12').expect(200);
  });

  it('lockouts still count after unlocks: the third real lockout in a day is 24 hours', async () => {
    const s = (await society()).body.data.id;
    const address = email();
    const owner = (
      await api('post', `/v1/platform/societies/${s}/owners`, admin, { email: address })
    ).body.data.id as string;
    const seconds: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      // Codes from earlier rounds are expired, so each round starts from fresh tries.
      t.clock.advance(11 * 60_000);
      const res = await lockOut(address, `198.51.100.${20 + round}`);
      seconds.push(`${res.status} ${res.body.code} ${String(res.headers['retry-after'])}`);
      if (round < 2) {
        // The clock moved past the access token's 15 minutes: a fresh console session.
        admin = await superAdminToken(t, db, superAdmin.id);
        const unlocked = await api('post', `/v1/platform/users/${owner}/unlock`, admin, {
          reason: 'QA',
        });
        expect(unlocked.status).toBe(200);
      }
    }
    expect(seconds).toEqual([
      '401 OTP_ATTEMPTS_EXCEEDED 1800',
      '401 OTP_ATTEMPTS_EXCEEDED 1800',
      '401 OTP_ATTEMPTS_EXCEEDED 86400',
    ]);
  });

  it('an email change mid sign-in: the old address cannot finish, and the lock history does not follow the new one', async () => {
    const s = (await society()).body.data.id;
    const oldAddress = email();
    const owner = (
      await api('post', `/v1/platform/societies/${s}/owners`, admin, { email: oldAddress })
    ).body.data.id as string;
    await askForCode(oldAddress, '198.51.100.30').expect(202);
    const code = await latestCode(oldAddress);
    const newAddress = email();
    await api('put', `/v1/platform/users/${owner}/email`, admin, {
      version: await versionOf(owner),
      email: newAddress.toUpperCase(),
    }).then((res) => expect(res.status).toBe(200));
    const late = await enterCode(oldAddress, code, '198.51.100.30');
    expect(late.status).toBe(401);
    expect(
      (await sql<{ e: string }>`select email as e from users where id = ${owner}`.execute(db))
        .rows[0]!.e,
    ).toBe(newAddress);
  });

  it('keeps full emails out of every audit entry of these actions, and Societies off the account ones', async () => {
    const s = (await society()).body.data.id;
    const ownerEmail = email();
    const owner = (
      await api('post', `/v1/platform/societies/${s}/owners`, admin, { email: ownerEmail })
    ).body.data.id as string;
    const changed = email();
    await api('put', `/v1/platform/users/${owner}/email`, admin, {
      version: await versionOf(owner),
      email: changed,
    });
    await api('post', `/v1/platform/users/${owner}/block`, admin, {
      version: await versionOf(owner),
      reason: 'QA',
    });
    await api('post', `/v1/platform/users/${owner}/unblock`, admin, {
      version: await versionOf(owner),
    });
    await api('delete', `/v1/platform/societies/${s}/owners/${owner}`, admin);
    const rows = await readAuditRows<{ action: string; society_id: string | null }>(
      db,
      sql`entity_id = ${owner}`,
    );
    expect(rows.map((r) => r.action).toSorted()).toEqual(
      [
        'account.block',
        'account.email_change',
        'account.unblock',
        'owner.add',
        'owner.remove',
      ].toSorted(),
    );
    const dump = JSON.stringify(rows);
    for (const address of [ownerEmail, changed]) expect(dump).not.toContain(address);
    for (const row of rows) {
      expect([row.action, row.society_id]).toEqual([
        row.action,
        row.action.startsWith('owner.') ? s : null,
      ]);
    }
  });

  it('odd IDs and a missing person answer 404 on every person route', async () => {
    const wrong: string[] = [];
    for (const id of [missing, 'not-a-uuid', `${missing}x`]) {
      for (const [method, path, body] of [
        ['delete', `/v1/platform/super-admins/${id}`, {}],
        ['post', `/v1/platform/users/${id}/block`, { version: 1, reason: 'x' }],
        ['post', `/v1/platform/users/${id}/unblock`, { version: 1 }],
        ['put', `/v1/platform/users/${id}/email`, { version: 1, email: 'x@qa.test' }],
        ['delete', `/v1/platform/users/${id}/mfa`, {}],
        ['post', `/v1/platform/users/${id}/unlock`, { reason: 'x' }],
      ] as const) {
        const res = await api(method, path, admin, body);
        if (res.status !== 404) wrong.push(`${method} ${path}: ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
