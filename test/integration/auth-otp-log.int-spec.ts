import { Kysely, PostgresDialect } from 'kysely';
import request from 'supertest';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { clearLoginState } from '../support/login-state.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const registered = personaByKey('P-A1-one').email;

// The process-wide root logger belongs to the first app created in a file, so
// the log assertions live in a file with exactly one app.
describe('AUTH-01 when the mail cannot be sent', () => {
  let owner: Kysely<unknown>;
  let t: TestApp;

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    owner = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(owner);
    await clearLoginState(owner);
    t = await createTestApp({ captureLogs: true });
  });

  afterAll(async () => {
    await t.close();
    await owner.destroy();
  });

  it('is still 202, and the log holds neither the address nor the code', async () => {
    vi.spyOn(t.email, 'send').mockRejectedValue(new Error(`smtp refused ${registered}`));
    await request(t.app.getHttpServer())
      .post('/v1/auth/otp')
      .send({ email: registered, clientType: 1 })
      .expect(202);
    await t.app.get(OtpService).flush();
    const text = JSON.stringify(t.logs);
    expect(text).toContain('Email was not sent');
    expect(text).not.toContain(registered);
    expect(text).not.toMatch(/\b\d{6}\b/);
  });
});
