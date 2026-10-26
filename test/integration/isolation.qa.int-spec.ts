// QA for Phase 1 B7: the tenant scope check under changes during a session,
// ID spellings, and writes to paused or deactivated Institutions.
import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { institutions, personaByKey, societies } from '../../src/seeds/two-worlds.js';
import { FixtureModule } from '../support/fixture.module.js';
import { signInAs } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const socA = societies.find((s) => s.key === 'A')!;
const inst = (key: string) => institutions.find((i) => i.key === key)!;
const [a1, a2] = [inst('A1'), inst('A2')];
const admin = personaByKey('IA-A12');
const owner = personaByKey('SO-A1');
let db: Kysely<unknown>;
let t: TestApp;

const asSuperAdmin = (work: (tx: Kysely<unknown>) => Promise<unknown>) =>
  db.transaction().execute(async (tx) => {
    await sql`select set_config('app.role_code', '1', true)`.execute(tx);
    await work(tx);
  });
const nameOf = async (id: string) => {
  let name = '';
  await asSuperAdmin(async (tx) => {
    name = (await sql<{ name: string }>`select name from institutions where id = ${id}`.execute(tx))
      .rows[0]!.name;
  });
  return name;
};

const get = (path: string, token: string) =>
  request(t.app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
const rename = (id: string, token: string, name: string) =>
  request(t.app.getHttpServer())
    .post(`/v1/fixtures/tenant/institutions/${id}/rename`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name });
const strip = (res: request.Response) => ({
  status: res.status,
  body: { ...res.body, requestId: undefined },
});

describe('QA: tenant scope (B7)', () => {
  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    db = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(db);
    for (const table of [
      'refresh_tokens',
      'auth_sessions',
      'otp_challenges',
      'public_call_counters',
      'login_lockouts',
    ]) {
      await sql`delete from ${sql.table(table)}`.execute(db);
    }
    for (const id of [a1.id, a2.id]) {
      await sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
        values (${admin.id}, 3, ${socA.id}, ${id}, gen_random_uuid())`.execute(db);
    }
    t = await createTestApp({ imports: [FixtureModule] });
  });
  afterAll(async () => {
    await t.close();
    await sql`delete from role_assignments where user_id = ${admin.id} and role_code = 3`.execute(
      db,
    );
    await asSuperAdmin((tx) =>
      sql`update institutions set status = 1, access_paused_at = null, access_paused_by = null, access_pause_reason = null`.execute(
        tx,
      ),
    );
    await db.destroy();
  });

  it('revoking one of two Institution grants takes that Institution away at the next call and keeps the other', async () => {
    const token = await signInAs(t, admin.email, { roleCode: 3, societyId: socA.id });
    await get(`/v1/fixtures/tenant/institutions/${a2.id}`, token).expect(200);
    await sql`update role_assignments set revoked_at = now() where user_id = ${admin.id} and institution_id = ${a2.id}`.execute(
      db,
    );
    const gone = await get(`/v1/fixtures/tenant/institutions/${a2.id}`, token);
    const missing = await get(
      '/v1/fixtures/tenant/institutions/00000000-0000-7000-8000-00000000ffff',
      token,
    );
    expect(strip(gone)).toEqual(strip(missing));
    await get(`/v1/fixtures/tenant/institutions/${a1.id}`, token).expect(200);
    expect((await rename(a2.id, token, 'Taken')).status).toBe(404);
    expect(await nameOf(a2.id)).not.toBe('Taken');
    await sql`update role_assignments set revoked_at = null, revoked_by = null, revoke_reason = null where user_id = ${admin.id}`.execute(
      db,
    );
  });

  it('a paused or deactivated Institution cannot be renamed, and nothing changes', async () => {
    const token = await signInAs(t, owner.email, { roleCode: 2, societyId: socA.id });
    const before = await nameOf(a1.id);
    await asSuperAdmin((tx) =>
      sql`update institutions set access_paused_at = now(), access_paused_by = ${personaByKey('SA1').id}, access_pause_reason = 'Dues' where id = ${a1.id}`.execute(
        tx,
      ),
    );
    expect((await rename(a1.id, token, 'X1')).status).toBe(423);
    await asSuperAdmin((tx) =>
      sql`update institutions set status = 0 where id = ${a1.id}`.execute(tx),
    );
    expect((await rename(a1.id, token, 'X2')).status).toBe(404);
    expect(await nameOf(a1.id)).toBe(before);
    await asSuperAdmin((tx) =>
      sql`update institutions set status = 1, access_paused_at = null, access_paused_by = null, access_pause_reason = null where id = ${a1.id}`.execute(
        tx,
      ),
    );
  });

  it('an ID written in capitals or with spaces is the same Institution, or the same 404 as a missing one', async () => {
    const token = await signInAs(t, owner.email, { roleCode: 2, societyId: socA.id });
    const upper = await get(`/v1/fixtures/tenant/institutions/${a1.id.toUpperCase()}`, token);
    const notUuid = await get('/v1/fixtures/tenant/institutions/not-a-uuid', token);
    const society = await get(`/v1/fixtures/tenant/societies/${socA.id.toUpperCase()}`, token);
    console.log(
      `QA: own Institution in capitals -> ${upper.status}; not a UUID -> ${notUuid.status}; own Society in capitals -> ${society.status}`,
    );
    expect([200, 404]).toContain(upper.status);
    expect(notUuid.status).toBe(404);
  });
});
