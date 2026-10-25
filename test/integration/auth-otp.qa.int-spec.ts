// QA for Phase 1 B2 (AUTH-01): parallel limits, answers that could tell a
// registered email from an unknown one, and what an error echoes back.
import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
let owner: Kysely<unknown>;

const registered = personaByKey('P-A1-one').email;
const superAdmin = personaByKey('SA1').email;
const teacher = personaByKey('T-A1-assigned').email;

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

describe('QA: AUTH-01', () => {
  let t: TestApp;
  const post = (body: Record<string, unknown>) =>
    request(t.app.getHttpServer()).post('/v1/auth/otp').send(body);

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
    await sql`delete from otp_challenges`.execute(owner);
    await sql`delete from public_call_hits`.execute(owner);
    await sql`update users set locked_until = null`.execute(owner);
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.app.get(OtpService).flush();
    await t.close();
  });

  it('the per-IP limit holds under parallel requests for different emails (at most 20 in a minute)', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        post({ email: `burst${i}@two-worlds.test`, clientType: 1 }),
      ),
    );
    const accepted = results.filter((res) => res.status === 202).length;
    expect(accepted).toBeLessThanOrEqual(20);
  });

  it('lets exactly one of ten parallel requests for one email through', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post({ email: registered, clientType: 1 })),
    );
    expect(results.filter((res) => res.status === 202)).toHaveLength(1);
  });

  it('gives a registered and an unknown email the same status, body, headers and size (mobile and console)', async () => {
    const cases: [string, number][] = [
      [registered, 1],
      [superAdmin, 2],
      [teacher, 2],
    ];
    for (const [email, clientType] of cases) {
      const known = await post({ email, clientType });
      const unknown = await post({
        email: `nobody.${email.split('@')[0]}.${clientType}@two-worlds.test`,
        clientType,
      });
      expect(visible(known)).toEqual(visible(unknown));
    }
  });

  it('gives the same 60-second refusal to a registered and an unknown email', async () => {
    await post({ email: registered, clientType: 1 });
    await post({ email: 'nobody.gap@two-worlds.test', clientType: 1 });
    const known = await post({ email: registered, clientType: 1 });
    const unknown = await post({ email: 'nobody.gap@two-worlds.test', clientType: 1 });
    expect(known.status).toBe(429);
    expect(visible(known)).toEqual(visible(unknown));
  });

  it('does not echo the email back in a validation error', async () => {
    const res = await post({ email: 'asha.rao@example', clientType: 1 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('asha.rao');
  });

  // R1 (a stranger using up the 3-in-15 limit) waits for BravyNix's decision; its test is added with the rule.
});
