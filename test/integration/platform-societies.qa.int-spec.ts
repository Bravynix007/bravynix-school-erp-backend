import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { institutions, personaByKey, societies } from '../../src/seeds/two-worlds.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { signInAs, signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/**
 * QA, slice B9a: attacks on PLT-02 to PLT-08 that the engineer's spec does not
 * cover. Scratch Societies and people are removed after each test.
 */
const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const societyA = societies.find((s) => s.key === 'A')!;
const societyB = societies.find((s) => s.key === 'B')!;
const BASE = '/v1/platform/societies';

type Method = 'get' | 'post' | 'patch' | 'delete';

describe('QA B9a: Societies on the platform console', () => {
  let db: Kysely<unknown>;
  let t: TestApp;
  let admin: string;
  const made: string[] = [];
  const people: string[] = [];

  const call = (method: Method, path: string, body: object = {}, token: string | null = admin) => {
    let req = request(t.app.getHttpServer())[method](path);
    if (token !== null) req = req.set('Authorization', `Bearer ${token}`);
    return method === 'get' || method === 'delete' ? req.send() : req.send(body);
  };

  const create = async (fields: Record<string, unknown> = {}) => {
    const res = await call('post', BASE, {
      name: 'QA Trust',
      code: `Q${newId().slice(-12)}`,
      ...fields,
    });
    if (res.status === 201) made.push(res.body.data.id as string);
    return res;
  };

  const person = async (email = `${newId()}@qa.test`) => {
    const id = newId();
    people.push(id);
    await sql`insert into users (id, email) values (${id}, ${email})`.execute(db);
    return { id, email };
  };

  /** An Institution in a scratch Society, written as Super Admin, the way the seed does it. */
  const institutionIn = async (societyId: string) => {
    const id = newId();
    await db.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      await sql`insert into institutions (id, society_id, name, code, address_line_1)
        values (${id}, ${societyId}, 'QA School', ${id.slice(-8)}, 'Road 1')`.execute(tx);
    });
    return id;
  };

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    db = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(db);
    t = await createTestApp({ imports: [FixtureModule] });
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
    for (const id of people.splice(0)) {
      await sql`delete from role_assignments where user_id = ${id}`.execute(db);
      await sql`delete from users where id = ${id}`.execute(db);
    }
  });

  it('refuses every endpoint to every caller but a Super Admin on the console', async () => {
    const target = (await create()).body.data as { id: string; version: number };
    const owner = await signInAs(t, personaByKey('SO-A1').email, {
      roleCode: 2,
      societyId: societyA.id,
    });
    // The seeded Institution Admins have no staff record yet, so one is made here.
    const admin3 = await person();
    await sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
      values (${admin3.id}, 3, ${societyA.id}, ${institutions.find((i) => i.key === 'A1')!.id}, ${newId()})`.execute(
      db,
    );
    const ia = await signInAs(t, admin3.email, { roleCode: 3, societyId: societyA.id });
    const teacher = (await signInMobile(t, personaByKey('T-A1-assigned').email)).accessToken;
    const parent = (await signInMobile(t, personaByKey('P-A1-one').email)).accessToken;
    // A Super Admin on a phone has no context, so no role.
    const saMobile = (await signInMobile(t, personaByKey('SA2').email)).accessToken;
    const callers: [string, string | null, number][] = [
      ['owner', owner, 403],
      ['institution admin', ia, 403],
      ['teacher', teacher, 403],
      ['parent', parent, 403],
      ['super admin on mobile', saMobile, 403],
      ['no token', null, 401],
      ['bad token', 'not-a-token', 401],
    ];
    const endpoints: [Method, string, object][] = [
      ['get', BASE, {}],
      ['post', BASE, { name: 'X', code: `X${newId().slice(-10)}` }],
      ['get', `${BASE}/${societyA.id}`, {}],
      ['patch', `${BASE}/${societyA.id}`, { version: 1, name: 'Hijacked' }],
      ['delete', `${BASE}/${target.id}`, {}],
      ['post', '/v1/platform/access-blocks', { section: 'owners', societyId: societyA.id }],
      ['delete', `/v1/platform/access-blocks/${societyB.id}`, {}],
    ];
    const wrong: string[] = [];
    for (const [who, token, expected] of callers) {
      for (const [method, path, body] of endpoints) {
        const res = await call(method, path, body, token);
        if (res.status !== expected) wrong.push(`${who} ${method} ${path}: ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
    const after = await call('get', `${BASE}/${target.id}`);
    expect(after.body.data.status).toBe(1);
    expect((await call('get', `${BASE}/${societyA.id}`)).body.data.name).not.toBe('Hijacked');
  });

  it('two Societies created at once with one code in two letter cases: one 201, one 409, never a 500', async () => {
    const code = `R${newId().slice(-10)}`;
    const answers = await Promise.all([
      create({ code: code.toUpperCase() }),
      create({ code: code.toLowerCase() }),
    ]);
    expect(answers.map((a) => a.status).toSorted()).toEqual([201, 409]);
    expect(answers.find((a) => a.status === 409)!.body.errors[0].field).toBe('code');
  });

  it('two edits with one version at once: one wins, the other gets VERSION_CONFLICT', async () => {
    const s = (await create()).body.data as { id: string; version: number };
    const answers = await Promise.all(
      ['First', 'Second'].map((name) =>
        call('patch', `${BASE}/${s.id}`, { version: s.version, name }),
      ),
    );
    expect(answers.map((a) => a.status).toSorted()).toEqual([200, 409]);
    expect(answers.find((a) => a.status === 409)!.body.code).toBe('VERSION_CONFLICT');
    expect(answers.find((a) => a.status === 409)!.body.data.currentVersion).toBe(s.version + 1);
  });

  it('a stale version beats INVALID_STATE on a deactivated Society', async () => {
    const s = (await create()).body.data as { id: string; version: number };
    await call('delete', `${BASE}/${s.id}`).expect(200);
    const now = (await call('get', `${BASE}/${s.id}`)).body.data.version as number;
    expect(now).toBeGreaterThan(s.version);
    const stale = await call('patch', `${BASE}/${s.id}`, { name: 'Y', version: s.version });
    expect(`${stale.status} ${stale.body.code}`).toBe('409 VERSION_CONFLICT');
    const edit = await call('patch', `${BASE}/${s.id}`, { name: 'Y', version: now });
    expect(`${edit.status} ${edit.body.code}`).toBe('409 INVALID_STATE');
  });

  it('a deactivated Society cannot have its Owners blocked: INVALID_STATE, as for an edit', async () => {
    const s = (await create()).body.data as { id: string };
    await call('delete', `${BASE}/${s.id}`).expect(200);
    const res = await call('post', '/v1/platform/access-blocks', {
      section: 'owners',
      societyId: s.id,
      reason: 'Fees',
    });
    expect(`${res.status} ${res.body.code}`).toBe('409 INVALID_STATE');
  });

  it('deactivation ends an Institution Admin, refuses a mobile refresh and a switch back, and leaves the person’s other Society alone', async () => {
    const s = (await create()).body.data as { id: string };
    const institution = await institutionIn(s.id);
    const p = await person();
    await sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
      values (${p.id}, 3, ${s.id}, ${institution}, ${newId()})`.execute(db);
    // Also an Institution Admin in Society A, so they keep a context after.
    await sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
      values (${p.id}, 3, ${societyA.id}, ${institutions.find((i) => i.key === 'A1')!.id}, ${newId()})`.execute(
      db,
    );
    const login = await signInMobile(t, p.email);
    const ctx = await request(t.app.getHttpServer())
      .post('/v1/auth/context')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ roleCode: 3, societyId: s.id })
      .expect(200);
    const inS = ctx.body.data as { accessToken: string };
    const refreshToken = (ctx.body.data.refreshToken as string | undefined) ?? login.refreshToken;
    const other = await signInAs(t, p.email, { roleCode: 3, societyId: societyA.id });

    const res = await call('delete', `${BASE}/${s.id}`).expect(200);
    expect(res.body.data).toEqual({ id: s.id, status: 0 });

    const me = await call('get', '/v1/me', {}, inS.accessToken);
    expect(me.status).toBe(401);
    expect(me.body).toMatchObject({ code: 'SESSION_ENDED', data: { reason: 'admin_revoked' } });
    const refreshed = await request(t.app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken });
    expect(refreshed.status).toBe(401);

    // The session in Society A goes on, and offers only Society A.
    const still = await call('get', '/v1/me', {}, other).expect(200);
    const contexts = still.body.data.contexts as { societyId: string }[];
    expect(contexts.map((c) => c.societyId)).toEqual([societyA.id]);
    const back = await request(t.app.getHttpServer())
      .post('/v1/auth/context')
      .set('Authorization', `Bearer ${other}`)
      .send({ roleCode: 3, societyId: s.id });
    expect(back.status).toBe(403);
    const [entry] = await readAuditRows<{ new_values: Record<string, unknown> }>(
      db,
      sql`action = 'society.deactivate' and society_id = ${s.id}`,
    );
    expect(entry!.new_values).toMatchObject({ status: 0, grantsRevoked: 1, sessionsEnded: 1 });
  });

  it('search treats a backslash literally, and paging edges answer as specified', async () => {
    const tag = newId().slice(-6);
    await create({ name: `Back\\slash ${tag}` });
    await create({ name: `Plain ${tag}` });
    const back = await call('get', `${BASE}?q=${encodeURIComponent(`k\\s`)}&limit=100`).expect(200);
    expect((back.body.data as { name: string }[]).map((s) => s.name)).toContain(
      `Back\\slash ${tag}`,
    );
    expect((back.body.data as { name: string }[]).every((s) => s.name.includes('\\'))).toBe(true);
    const lone = await call('get', `${BASE}?q=${encodeURIComponent('\\\\')}`);
    expect(lone.status).toBe(200);

    const far = await call('get', `${BASE}?page=999&limit=10`).expect(200);
    expect(far.body.data).toEqual([]);
    expect(far.body.meta.totalItems).toBeGreaterThan(0);
    for (const query of [
      'limit=0',
      'limit=101',
      'page=0',
      'sort=id',
      'sort=-version',
      'blocked=yes',
      'status=2',
    ]) {
      expect([query, (await call('get', `${BASE}?${query}`)).status]).toEqual([query, 400]);
    }
  });

  it('an ID in capitals finds the Society; odd IDs are 404', async () => {
    const s = (await create()).body.data as { id: string };
    await call('get', `${BASE}/${s.id.toUpperCase()}`).expect(200);
    for (const id of [`${s.id}x`, `{${s.id}}`, s.id.replaceAll('-', ''), '..', '%20']) {
      expect([id, (await call('get', `${BASE}/${id}`)).status]).toEqual([id, 404]);
    }
  });

  it('records what the create and update validation lets through', async () => {
    const seen: string[] = [];
    const tryCreate = async (label: string, fields: Record<string, unknown>) => {
      const res = await create(fields);
      seen.push(`${label}: ${res.status}`);
      return res;
    };
    const code = `T${newId().slice(-10)}`;
    await tryCreate('code', { code });
    await tryCreate('same code with a trailing space', { code: `${code} ` });
    await tryCreate('code of spaces', { code: '   ' });
    await tryCreate('name of spaces', { name: '   ' });
    await tryCreate('foundedDate in the future', { foundedDate: '2999-01-01' });
    await tryCreate('foundedDate 2026-02-30', { foundedDate: '2026-02-30' });
    await tryCreate('website javascript:', { website: 'javascript:alert(1)' });
    await tryCreate('created_at field', { createdAt: '2020-01-01T00:00:00Z' });
    await tryCreate('status field', { status: 0 });
    console.info(`QA B9a validation:\n${seen.join('\n')}`);
    expect(seen).toContain('foundedDate 2026-02-30: 400');
    expect(seen).toContain('website javascript:: 400');
    expect(seen).toContain('created_at field: 400');
    expect(seen).toContain('status field: 400');
  });

  it('an edit that sends the same date, phone and email (in capitals) writes nothing', async () => {
    const s = (
      await create({
        foundedDate: '1998-06-01',
        email: 'office@qa.test',
        phone: { countryCode: '91', number: '9876501234' },
        address: { line1: 'Road 1', line2: null, pincode: '560001' },
      })
    ).body.data as { id: string; version: number };
    const res = await call('patch', `${BASE}/${s.id}`, {
      version: s.version,
      foundedDate: '1998-06-01',
      email: 'OFFICE@QA.TEST',
      phone: { countryCode: '91', number: '9876501234' },
      address: { line1: 'Road 1', pincode: '560001' },
    }).expect(200);
    expect(res.body.data.version).toBe(s.version);
    expect(
      await readAuditRows(db, sql`action = 'society.update' and society_id = ${s.id}`),
    ).toHaveLength(0);
  });
});
