import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { TokenService } from '../../src/platform/identity/token.service.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/**
 * QA, slice B9b: attacks on INS-01 to INS-05 and PLT-19 to PLT-21 that the
 * engineer's spec does not cover. Everything runs in scratch Societies,
 * removed after each test.
 */
const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

type Method = 'get' | 'post' | 'patch' | 'delete';

const shape = (res: request.Response) =>
  JSON.stringify({ status: res.status, code: res.body.code, data: res.body.data });

describe('QA B9b: Institutions', () => {
  let db: Kysely<unknown>;
  let t: TestApp;
  let fixtures: PlatformFixtures;
  let admin: string;
  const made: string[] = [];
  const people: string[] = [];

  const call = (method: Method, path: string, token: string | null, body: object = {}) => {
    let req = request(t.app.getHttpServer())[method](path);
    if (token !== null) req = req.set('Authorization', `Bearer ${token}`);
    return method === 'get' || method === 'delete' ? req.send() : req.send(body);
  };
  const society = async () => {
    const res = await call('post', '/v1/platform/societies', admin, {
      name: 'QA Trust',
      code: `Q${newId().slice(-12)}`,
    }).expect(201);
    made.push(res.body.data.id as string);
    return res.body.data.id as string;
  };
  /** The Institution row as Super Admin sees it: the table forces row-level security even on its owner. */
  const rowOf = async (id: string) =>
    db.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      const { rows } = await sql<{ status: number; version: number; paused: boolean }>`
        select status, version, access_paused_at is not null as paused from institutions where id = ${id}`.execute(
        tx,
      );
      return rows[0]!;
    });
  /** A new person with no grant, signed in on a phone. */
  const signedInWithoutGrant = async () => {
    const id = newId();
    people.push(id);
    await sql`insert into users (id, email) values (${id}, ${`${id}@qa.test`})`.execute(db);
    return (await signInMobile(t, `${id}@qa.test`)).accessToken;
  };
  /** A phone session with no context for that person, made without the sign-in steps. */
  const mobileToken = async (personId: string) => {
    const { rows } = await sql<{ id: string }>`
      insert into auth_sessions (user_id, client_type, idle_expires_at, absolute_expires_at)
      values (${personId}, 1, now() + interval '1 hour', now() + interval '1 hour') returning id`.execute(
      db,
    );
    const signed = await t.app
      .get(TokenService)
      .signAccessToken(
        { personId, sessionId: rows[0]!.id, roleCode: null, societyId: null, clientType: 'mobile' },
        t.clock.now(),
      );
    return signed.token;
  };
  const createAs = (token: string, fields: Record<string, unknown>) =>
    call('post', '/v1/institutions', token, {
      name: 'QA School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '1 Road' },
      ...fields,
    });
  const institution = async (societyId: string, fields: Record<string, unknown> = {}) => {
    const res = await createAs(admin, { societyId, ...fields }).expect(201);
    return res.body.data as { id: string; version: number };
  };

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    db = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(db);
    t = await createTestApp({ imports: [FixtureModule] });
    fixtures = new PlatformFixtures(t, db);
  });

  afterAll(async () => {
    await clearLoginState(db);
    await t.close();
    await db.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(db);
    admin = await superAdminToken(t, db, superAdmin.id);
  });

  afterEach(async () => {
    await clearLoginState(db);
    await removeScratchSocieties(db, made.splice(0));
    await fixtures.cleanup();
    for (const id of people.splice(0)) await sql`delete from users where id = ${id}`.execute(db);
  });

  it('refuses each endpoint to every caller outside its roles, and changes nothing', async () => {
    const s = await society();
    const inst = await institution(s);
    const owner = (await fixtures.owner(s)).token;
    const ia = (await fixtures.institutionAdmin(s, [inst.id])).token;
    // Teachers and parents have no role until the People module, so a person with no grant stands in
    // for both. Seeded people are not used: other spec files lock their emails while running in parallel.
    const noRole = await signedInWithoutGrant();
    const saMobile = await mobileToken(superAdmin.id);
    const tokens: Record<string, string | null> = {
      'super admin': admin,
      owner,
      'institution admin': ia,
      'teacher or parent (no role yet)': noRole,
      'super admin on mobile': saMobile,
      'no token': null,
      'bad token': 'not-a-token',
    };
    const one = `/v1/institutions/${inst.id}`;
    const plat = `/v1/platform/institutions/${inst.id}`;
    const endpoints: [string, Method, string, object, string[]][] = [
      ['INS-01', 'get', '/v1/institutions', {}, ['owner', 'institution admin']],
      ['INS-02', 'post', '/v1/institutions', { name: 'X' }, ['owner', 'super admin']],
      ['INS-03', 'get', one, {}, ['owner', 'institution admin']],
      ['INS-04', 'patch', one, { version: 999, name: 'Hijacked' }, ['owner', 'super admin']],
      ['INS-05', 'delete', `/v1/institutions/${missing}`, {}, ['owner', 'super admin']],
      ['PLT-19', 'get', '/v1/platform/institutions', {}, ['super admin']],
      ['PLT-20', 'post', `${plat}/pause`, { version: 999, reason: 'x' }, ['super admin']],
      ['PLT-21', 'post', `${plat}/resume`, { version: 999 }, ['super admin']],
    ];
    const wrong: string[] = [];
    for (const [op, method, path, body, allowed] of endpoints) {
      for (const [who, token] of Object.entries(tokens)) {
        const status = (await call(method, path, token, body)).status;
        const expected = allowed.includes(who)
          ? 'allowed'
          : token === null || who === 'bad token'
            ? 401
            : 403;
        const ok = expected === 'allowed' ? ![401, 403].includes(status) : status === expected;
        if (!ok) wrong.push(`${op} ${who}: ${status}`);
      }
    }
    expect(wrong).toEqual([]);
    const after = await call('get', one, owner).expect(200);
    expect(after.body.data).toMatchObject({ name: 'QA School', status: 1, version: inst.version });
  });

  it('an Owner of another Society gets the same 404 as a missing ID, for read, edit and deactivate', async () => {
    const a = await society();
    const b = await society();
    const theirs = await institution(b);
    const owner = (await fixtures.owner(a)).token;
    for (const [method, body] of [
      ['get', {}],
      ['patch', { version: theirs.version, name: 'Hijacked' }],
      ['delete', {}],
    ] as const) {
      const foreign = await call(method, `/v1/institutions/${theirs.id}`, owner, body);
      const unknown = await call(method, `/v1/institutions/${missing}`, owner, body);
      expect(foreign.status).toBe(404);
      expect(shape(foreign)).toBe(shape(unknown));
    }
    const still = await call('get', `/v1/platform/institutions?societyId=${b}`, admin).expect(200);
    expect(still.body.data[0]).toMatchObject({ name: 'QA School', status: 1 });
  });

  it('an Owner naming another Society, or a Super Admin naming a missing one, adds nothing there', async () => {
    const a = await society();
    const b = await society();
    const owner = (await fixtures.owner(a)).token;
    const named = await createAs(owner, { societyId: b });
    expect(named.status).toBe(400);
    expect(named.body.errors[0]).toMatchObject({ field: 'societyId', code: 'FIELD_NOT_ALLOWED' });
    expect((await createAs(admin, { societyId: missing })).status).toBe(404);
    expect((await createAs(admin, { societyId: 'not-a-uuid' })).status).toBe(400);
    const inB = await call('get', `/v1/platform/institutions?societyId=${b}`, admin).expect(200);
    expect(inB.body.data).toEqual([]);
  });

  it('two creates at once with one code in two letter cases: one 201, one 409; the code is free in another Society', async () => {
    const a = await society();
    const b = await society();
    const code = `C${newId().slice(-8)}`;
    const answers = await Promise.all([
      createAs(admin, { societyId: a, code: code.toUpperCase() }),
      createAs(admin, { societyId: a, code: code.toLowerCase() }),
    ]);
    expect(answers.map((r) => r.status).toSorted()).toEqual([201, 409]);
    expect(answers.find((r) => r.status === 409)!.body.errors[0].field).toBe('code');
    expect((await createAs(admin, { societyId: b, code })).status).toBe(201);
  });

  it('records what create and edit validation lets through', async () => {
    const s = await society();
    const seen: string[] = [];
    const tryCreate = async (label: string, fields: Record<string, unknown>) => {
      const res = await createAs(admin, { societyId: s, ...fields });
      seen.push(`${label}: ${res.status}`);
    };
    await tryCreate('address line1 of spaces', { address: { line1: '   ' } });
    await tryCreate('no address', { address: undefined });
    await tryCreate('address null', { address: null });
    await tryCreate('name of spaces', { name: '   ' });
    await tryCreate('code of spaces', { code: '   ' });
    await tryCreate('boardCode 7', { boardCode: 7 });
    await tryCreate('boardCode "1"', { boardCode: '1' });
    await tryCreate('boardCode 1.5', { boardCode: 1.5 });
    await tryCreate('gstin lower case', { gstin: '29abcde1234f1z5' });
    await tryCreate('gstin 14th not Z', { gstin: '29ABCDE1234F1Y5' });
    await tryCreate('location latitude only', { location: { latitude: 12.5 } });
    await tryCreate('location 7 decimals', { location: { latitude: 12.1234567, longitude: 77 } });
    await tryCreate('location latitude 90.000001', {
      location: { latitude: 90.000001, longitude: 0 },
    });
    await tryCreate('location as strings', { location: { latitude: '12.5', longitude: '77.5' } });
    await tryCreate('email with capitals', { email: 'Office@QA.Test' });
    await tryCreate('phone with +', { phone: { countryCode: '+91', number: '9876501234' } });
    await tryCreate('status field', { status: 0 });
    const inst = await institution(s, { location: { latitude: -0.000001, longitude: 180 } });
    const patch = async (label: string, fields: Record<string, unknown>) => {
      const current = (
        await call('get', `/v1/platform/institutions?societyId=${s}&limit=100`, admin)
      ).body.data.find((r: { id: string }) => r.id === inst.id) as { version?: number } | undefined;
      const res = await call('patch', `/v1/institutions/${inst.id}`, admin, {
        version: current?.version ?? inst.version,
        ...fields,
      });
      seen.push(`edit ${label}: ${res.status}`);
    };
    await patch('address null', { address: null });
    await patch('address {}', { address: {} });
    await patch('address line1 ""', { address: { line1: '' } });
    await patch('location null', { location: null });
    await patch('societyId', { societyId: s });
    await patch('code', { code: 'NEW' });
    console.info(`QA B9b validation:\n${seen.join('\n')}`);
    const expected400 = seen.filter(
      (line) => !line.startsWith('email') && !line.startsWith('edit location null'),
    );
    expect(expected400.filter((line) => !line.endsWith(': 400'))).toEqual([]);
    expect(seen).toContain('email with capitals: 201');
  });

  it('keeps an exact location: -0.000001 and 180 come back as sent, and resending them writes nothing', async () => {
    const s = await society();
    const inst = await institution(s, { location: { latitude: -0.000001, longitude: 180 } });
    const owner = (await fixtures.owner(s)).token;
    const read = await call('get', `/v1/institutions/${inst.id}`, owner).expect(200);
    expect(read.body.data.location).toEqual({ latitude: -0.000001, longitude: 180 });
    const same = await call('patch', `/v1/institutions/${inst.id}`, owner, {
      version: inst.version,
      location: { latitude: -0.000001, longitude: 180.0 },
      boardCode: null,
    }).expect(200);
    expect(same.body.data.version).toBe(inst.version);
  });

  it('deactivating the only Institution of an Admin: next call 401, refresh refused, sign-in again offers nothing', async () => {
    const s = await society();
    const inst = await institution(s);
    const adminOf = await fixtures.institutionAdmin(s, [inst.id]);
    const login = await signInMobile(t, adminOf.email);
    await call('delete', `/v1/institutions/${inst.id}`, admin).expect(200);
    const me = await call('get', '/v1/me', login.accessToken);
    expect(me.status).toBe(401);
    expect(me.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'admin_revoked' } });
    const refreshed = await request(t.app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.refreshToken });
    expect(refreshed.status).toBe(401);
    const again = await signInMobile(t, adminOf.email);
    expect(again.contexts).toEqual([]);
  });

  it('an Admin of two keeps the other: INS-01 lists only it, the deactivated one is 404', async () => {
    const s = await society();
    const one = await institution(s, { name: 'Alpha' });
    const two = await institution(s, { name: 'Beta' });
    const adminOf = await fixtures.institutionAdmin(s, [one.id, two.id]);
    await call('delete', `/v1/institutions/${one.id}`, admin).expect(200);
    const list = await call('get', '/v1/institutions', adminOf.token).expect(200);
    expect((list.body.data as { id: string }[]).map((i) => i.id)).toEqual([two.id]);
    expect((await call('get', `/v1/institutions/${one.id}`, adminOf.token)).status).toBe(404);
    await call('get', `/v1/institutions/${two.id}`, adminOf.token).expect(200);
  });

  it('a pause and a deactivation at once: both may win, but the row stays consistent', async () => {
    const s = await society();
    const inst = await institution(s);
    const [paused, gone] = await Promise.all([
      call('post', `/v1/platform/institutions/${inst.id}/pause`, admin, {
        version: inst.version,
        reason: 'Fees',
      }),
      call('delete', `/v1/institutions/${inst.id}`, admin),
    ]);
    const row = await rowOf(inst.id);
    console.info(
      `QA B9b pause vs deactivate: pause ${paused.status}, delete ${gone.status}, row ${JSON.stringify(row)}`,
    );
    expect(gone.status).toBe(200);
    expect(row.status).toBe(0);
    expect([200, 409]).toContain(paused.status);
    expect(row.paused).toBe(paused.status === 200);
  });

  it('a stale version beats INVALID_STATE on a deactivated Institution, for edit, pause and resume', async () => {
    const s = await society();
    const inst = await institution(s);
    await call('post', `/v1/platform/institutions/${inst.id}/pause`, admin, {
      version: inst.version,
      reason: 'Fees',
    }).expect(200);
    await call('delete', `/v1/institutions/${inst.id}`, admin).expect(200);
    const stale = { version: inst.version };
    for (const [method, path, body] of [
      ['patch', `/v1/institutions/${inst.id}`, { name: 'Y' }],
      ['post', `/v1/platform/institutions/${inst.id}/pause`, { reason: 'x' }],
      ['post', `/v1/platform/institutions/${inst.id}/resume`, {}],
    ] as const) {
      const res = await call(method, path, admin, { ...body, ...stale });
      expect(`${path} ${res.status} ${res.body.code}`).toBe(`${path} 409 VERSION_CONFLICT`);
    }
    const row = await rowOf(inst.id);
    const resume = await call('post', `/v1/platform/institutions/${inst.id}/resume`, admin, {
      version: row.version,
    });
    expect(`${resume.status} ${resume.body.code}`).toBe('409 INVALID_STATE');
  });

  it('a paused Institution: the Owner gets 423 on it, Super Admin edits and deactivates it, the audit carries both IDs', async () => {
    const s = await society();
    const inst = await institution(s);
    const owner = (await fixtures.owner(s)).token;
    await call('post', `/v1/platform/institutions/${inst.id}/pause`, admin, {
      version: inst.version,
      reason: 'Fees',
    }).expect(200);
    for (const [method, body] of [
      ['get', {}],
      ['patch', { version: inst.version + 1, name: 'Owner edit' }],
      ['delete', {}],
    ] as const) {
      expect((await call(method, `/v1/institutions/${inst.id}`, owner, body)).status).toBe(423);
    }
    await call('get', '/v1/institutions', owner).expect(200);
    await call('patch', `/v1/institutions/${inst.id}`, admin, {
      version: inst.version + 1,
      name: 'Admin edit',
    }).expect(200);
    await call('delete', `/v1/institutions/${inst.id}`, admin).expect(200);
    const entries = await readAuditRows<{
      action: string;
      society_id: string;
      institution_id: string;
      reason: string | null;
    }>(db, sql`entity_id = ${inst.id}`);
    expect(entries.map((e) => e.action)).toEqual([
      'institution.create',
      'access.pause',
      'institution.update',
      'institution.deactivate',
    ]);
    for (const e of entries) expect([e.society_id, e.institution_id]).toEqual([s, inst.id]);
    expect(entries[1]!.reason).toBe('Fees');
  });

  it('PLT-19 takes a backslash literally and pages past the end with the true total', async () => {
    const s = await society();
    const tag = newId().slice(-6);
    await institution(s, { name: `Back\\slash ${tag}` });
    await institution(s, { name: `Plain ${tag}` });
    const found = await call(
      'get',
      `/v1/platform/institutions?societyId=${s}&q=${encodeURIComponent('k\\s')}`,
      admin,
    ).expect(200);
    expect((found.body.data as { name: string }[]).map((r) => r.name)).toEqual([
      `Back\\slash ${tag}`,
    ]);
    const far = await call(
      'get',
      `/v1/platform/institutions?societyId=${s}&page=5&limit=1`,
      admin,
    ).expect(200);
    expect(far.body.data).toEqual([]);
    expect(far.body.meta.totalItems).toBe(2);
  });
});
