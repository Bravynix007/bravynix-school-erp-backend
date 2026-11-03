import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { classes, writeAcademicSeed } from '../../src/seeds/academic-seed.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

/** Thrown to end the transaction, so the seeded rows never stay in the shared test database. */
class Rollback extends Error {}

describe('the two-worlds academic seed', () => {
  let db: Kysely<unknown>;

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    db = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('gives the Institutions their classes and sections, written once however often it runs', async () => {
    await expect(
      db.transaction().execute(async (tx) => {
        await writeAcademicSeed(tx);
        await writeAcademicSeed(tx);
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`alter table classes no force row level security`.execute(tx);
        await sql`alter table sections no force row level security`.execute(tx);
        const ids = sql.join(classes.map((row) => sql`${row.id}`));
        const found = await sql<{
          display_name: string;
          stream_name: string | null;
          sections: number;
        }>`
          select c.display_name, c.stream_name, count(s.id)::int as sections
          from classes c left join sections s on s.class_id = c.id
          where c.id in (${ids}) group by c.id order by c.display_name
        `.execute(tx);
        expect(found.rows).toEqual([
          { display_name: '1st', stream_name: null, sections: 2 },
          { display_name: '9th', stream_name: null, sections: 1 },
          { display_name: 'Nursery', stream_name: null, sections: 1 },
          { display_name: 'PUC 1st Year PCMC', stream_name: 'PCMC', sections: 1 },
        ]);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
