import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import {
  admins,
  asha,
  institutions,
  meera,
  owners,
  people,
  societies,
  superAdmin,
  writeDemoSeed,
} from '../../src/seeds/demo.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

const count = async (tx: Kysely<unknown>, query: ReturnType<typeof sql<{ n: number }>>) =>
  (await query.execute(tx)).rows[0]!.n;

const ids = (rows: { id: string }[]) => sql.join(rows.map((r) => sql`${r.id}`));

/** Thrown to end the transaction, so the demo rows never stay in the shared test database. */
class Rollback extends Error {}

describe('the demo seed', () => {
  let db: Kysely<unknown>;

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    db = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  /** Runs the checks inside a transaction that is rolled back, with the seed written (twice, when asked). */
  const withDemo = async (times: number, check: (tx: Kysely<unknown>) => Promise<void>) => {
    await expect(
      db.transaction().execute(async (tx) => {
        for (let i = 0; i < times; i++) await writeDemoSeed(tx);
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await check(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  };

  it('writes the people, Societies, Institutions and grants the demo story needs', async () => {
    await withDemo(1, async (tx) => {
      expect(
        await count(
          tx,
          sql<{ n: number }>`select count(*)::int n from users where id in (${ids(people)})`,
        ),
      ).toBe(people.length);
      expect(
        await count(
          tx,
          sql<{ n: number }>`select count(*)::int n from societies where id in (${ids(societies)})`,
        ),
      ).toBe(societies.length);
      expect(
        await count(
          tx,
          sql<{
            n: number;
          }>`select count(*)::int n from institutions where id in (${ids(institutions)})`,
        ),
      ).toBe(institutions.length);
      // Asha owns both Societies, so her app offers a choice; Meera owns only the first.
      const ownerGrants = await sql<{ email: string; code: string }>`
        select u.email, s.code from role_assignments r
        join users u on u.id = r.user_id join societies s on s.id = r.society_id
        where r.role_code = 2 and r.revoked_at is null and u.id in (${sql.join([asha, meera].map((p) => sql`${p.id}`))})
        order by u.email, s.code
      `.execute(tx);
      expect(ownerGrants.rows).toEqual([
        { email: asha.email, code: 'LET' },
        { email: asha.email, code: 'SVES' },
        { email: meera.email, code: 'SVES' },
      ]);
      const adminGrants = await sql<{ email: string; code: string }>`
        select u.email, i.code from role_assignments r
        join users u on u.id = r.user_id join institutions i on i.id = r.institution_id
        where r.role_code = 3 and r.revoked_at is null and u.id in (${sql.join(admins.map((a) => sql`${a.person.id}`))})
        order by i.code
      `.execute(tx);
      expect(adminGrants.rows.map((r) => r.code)).toEqual(['SVHS', 'SVPS']);
      expect(
        await count(
          tx,
          sql<{ n: number }>`select count(*)::int n from role_assignments
            where user_id = ${superAdmin.id} and role_code = 1 and revoked_at is null`,
        ),
      ).toBe(1);
    });
  });

  it('is safe to run twice: nothing is written a second time', async () => {
    await withDemo(2, async (tx) => {
      const peopleIds = ids(people);
      expect(
        await count(
          tx,
          sql<{
            n: number;
          }>`select count(*)::int n from role_assignments where user_id in (${peopleIds})`,
        ),
      ).toBe(1 + owners.length + admins.length);
      expect(
        await count(
          tx,
          sql<{ n: number }>`select count(*)::int n from users where id in (${peopleIds})`,
        ),
      ).toBe(people.length);
    });
  });

  it('leaves no blocks, so the demo applies the first one live', async () => {
    await withDemo(1, async (tx) => {
      expect(
        await count(
          tx,
          sql<{ n: number }>`select count(*)::int n from access_blocks
            where society_id in (${sql.join(societies.map((s) => sql`${s.id}`))})`,
        ),
      ).toBe(0);
    });
  });
});
