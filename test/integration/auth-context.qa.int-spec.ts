// QA for Phase 1 B5 (AUTH-06, ME-01): switch edges, races and revoked grants.
import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { institutions, personaByKey, societies } from '../../src/seeds/two-worlds.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
let db: Kysely<unknown>;
const owner = personaByKey('SO-A1');
const societyA = societies.find((s) => s.key === 'A')!;
const societyB = societies.find((s) => s.key === 'B')!;
const institutionB = institutions.find((i) => i.key === 'B1')!;

const auditCount = async (action: string) => {
  let n = 0;
  await db
    .transaction()
    .execute(async (trx) => {
      await sql`alter table audit_logs no force row level security`.execute(trx);
      n = (
        await sql<{
          n: number;
        }>`select count(*)::int as n from audit_logs where action = ${action}`.execute(trx)
      ).rows[0]!.n;
      throw new Error('rollback');
    })
    .catch(() => undefined);
  return n;
};

describe('QA: AUTH-06 and ME-01', () => {
  let t: TestApp;
  const signIn = (email: string) => signInMobile(t, email);
  const call = (method: 'get' | 'post', path: string, token: string, body: object = {}) =>
    request(t.app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`).send(body);
  const switchTo = (token: string, body: Record<string, unknown>) =>
    call('post', '/v1/auth/context', token, body);

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    db = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(db);
  });
  afterAll(async () => {
    // Leave the owner with one context, as the other files expect.
    await sql`delete from role_assignments where user_id = ${owner.id} and role_code = 3`.execute(
      db,
    );
    await sql`update role_assignments set revoked_at = null, revoked_by = null, revoke_reason = null where user_id = ${owner.id}`.execute(
      db,
    );
    await db.destroy();
  });
  beforeEach(async () => {
    await clearLoginState(db);
    await sql`delete from role_assignments where user_id = ${owner.id} and role_code = 3`.execute(
      db,
    );
    await sql`update role_assignments set revoked_at = null, revoked_by = null, revoke_reason = null where user_id = ${owner.id}`.execute(
      db,
    );
    await sql`update users set locked_until = null, failed_login_count = 0`.execute(db);
    // A second context: Institution Admin in Society B.
    await sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
      values (${owner.id}, 3, ${societyB.id}, ${institutionB.id}, gen_random_uuid())`.execute(db);
    t = await createTestApp({ imports: [FixtureModule] });
  });
  afterEach(async () => {
    await t.app.get(OtpService).flush();
    await t.close();
  });

  it('accepts a Society ID written in capitals, as iOS writes UUIDs', async () => {
    const login = await signIn(owner.email);
    const res = await switchTo(login.accessToken, {
      roleCode: 3,
      societyId: societyB.id.toUpperCase(),
    });
    expect(res.status).toBe(200);
  });

  it('answers a null societyId for roles 2 to 4 as a validation error, like a missing one', async () => {
    const login = await signIn(owner.email);
    const res = await switchTo(login.accessToken, { roleCode: 2, societyId: null });
    expect(res.status).toBe(400);
  });

  it('refuses the right role in the wrong Society, and a held Society with the wrong role', async () => {
    const login = await signIn(owner.email);
    expect(
      (await switchTo(login.accessToken, { roleCode: 2, societyId: societyB.id })).body.code,
    ).toBe('CONTEXT_NOT_AVAILABLE');
    expect(
      (await switchTo(login.accessToken, { roleCode: 3, societyId: societyA.id })).body.code,
    ).toBe('CONTEXT_NOT_AVAILABLE');
    expect((await switchTo(login.accessToken, { roleCode: 1 })).status).toBe(400);
    expect(
      (await switchTo(login.accessToken, { roleCode: 4, societyId: societyA.id })).body.code,
    ).toBe('CONTEXT_NOT_AVAILABLE');
    expect((await switchTo(login.accessToken, { roleCode: 5 })).body.code).toBe(
      'CONTEXT_NOT_AVAILABLE',
    );
  });

  it('a revoked grant after the switch ends the session at the next call, for the new token and the old one', async () => {
    const login = await signIn(owner.email);
    const switched = await switchTo(login.accessToken, {
      roleCode: 3,
      societyId: societyB.id,
    }).expect(200);
    await sql`update role_assignments set revoked_at = now() where user_id = ${owner.id} and role_code = 3`.execute(
      db,
    );
    const res = await call('get', '/v1/me', switched.body.data.accessToken);
    expect(res.status).toBe(401);
    expect(res.body.data?.reason ?? res.body.details?.reason).toBeDefined();
    expect((await call('get', '/v1/me', login.accessToken)).status).toBe(401);
  });

  it('a switch racing a logout does not answer 200 or audit a switch for an ended session', async () => {
    let bad = 0;
    for (let i = 0; i < 10; i += 1) {
      const login = await signIn(owner.email);
      const before = await auditCount('auth.context_switch');
      const [sw] = await Promise.all([
        switchTo(login.accessToken, { roleCode: 3, societyId: societyB.id }),
        call('post', '/v1/auth/logout', login.accessToken),
      ]);
      const { rows } = await sql<{ ended: boolean; role: number | null }>`
        select ended_at is not null as ended, active_role_code as role from auth_sessions where id = ${login.session.id}`.execute(
        db,
      );
      if (sw.status === 200 && rows[0]!.ended && rows[0]!.role !== 3) bad += 1;
      if ((await auditCount('auth.context_switch')) > before && rows[0]!.role !== 3) bad += 1;
      t.clock.advance(15 * 60_000);
    }
    console.log(`QA: switch answered 200 or audited for a session that ended first: ${bad} of 10`);
    expect(bad).toBe(0);
  });
});
