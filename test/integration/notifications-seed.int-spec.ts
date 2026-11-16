import { Kysely, PostgresDialect, sql } from 'kysely';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeAcademicSeed } from '../../src/seeds/academic-seed.js';
import { writeBillingSeed } from '../../src/seeds/billing-seed.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { seededInboxItemId, writeNotificationsSeed } from '../../src/seeds/notifications-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { FixtureModule } from '../support/fixture.module.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

/** The notices of the two worlds (notifications-seed): one in the inbox of each Owner and Admin, read by them alone. */
describe('notifications seed', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    await writeBillingSeed(ownerDb);
    await writeAcademicSeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
    await writeNotificationsSeed(ownerDb);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  const inboxOf = (key: string) =>
    database.transaction({ personId: personaByKey(key).id, roleCode: 2 }, async (tx) =>
      (await sql<{ id: string }>`select id from inbox_items`.execute(tx)).rows.map((r) => r.id),
    );

  it('puts one notice in the inbox of each Owner and Admin, and each sees only theirs', async () => {
    for (const key of ['SO-A1', 'IA-A1', 'SO-B1', 'IA-B1']) {
      expect(await inboxOf(key)).toEqual([seededInboxItemId(key)]);
    }
    expect(await inboxOf('SO-A2')).toEqual([]);
  });

  it('adds nothing when it runs again', async () => {
    await writeNotificationsSeed(ownerDb);
    expect(await inboxOf('SO-A1')).toEqual([seededInboxItemId('SO-A1')]);
  });
});
