import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import {
  admins,
  asha,
  classesOffered,
  dues,
  institutions,
  meera,
  owners,
  people,
  rates,
  societies,
  subjects,
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
        // Another test file may have left the invoice counter moved; this run starts it afresh.
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`delete from number_sequences where sequence_type = 3 and period_key = 'FY2026-27'`.execute(
          tx,
        );
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

  it('gives every Institution one current academic year, written once however often it runs', async () => {
    await withDemo(2, async (tx) => {
      // The table is scoped to an Institution even for its owner; lifting that for this rolled-back transaction.
      await sql`alter table academic_years no force row level security`.execute(tx);
      const rows = await sql<{ code: string; current: number; total: number }>`
        select i.code, count(*) filter (where y.is_current)::int as current, count(*)::int as total
        from academic_years y join institutions i on i.id = y.institution_id
        where y.institution_id in (${ids(institutions)})
        group by i.code order by i.code
      `.execute(tx);
      expect(rows.rows).toEqual([
        { code: 'LPS', current: 1, total: 1 },
        { code: 'SVHS', current: 1, total: 2 },
        { code: 'SVPS', current: 1, total: 1 },
      ]);
    });
  });

  it('gives each Society its subjects, written once however often it runs', async () => {
    await withDemo(2, async (tx) => {
      await sql`alter table subjects no force row level security`.execute(tx);
      const rows = await sql<{ code: string; names: string[] }>`
        select s.code, array_agg(j.name order by j.name) as names
        from subjects j join societies s on s.id = j.society_id
        where j.id in (${sql.join(subjects.map((subject) => sql`${subject.id}`))})
        group by s.code order by s.code
      `.execute(tx);
      expect(rows.rows).toEqual([
        { code: 'LET', names: ['English', 'Mathematics', 'Science', 'Social Science'] },
        { code: 'SVES', names: ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science'] },
      ]);
    });
  });

  it('gives each Institution the class categories it offers, written once however often it runs', async () => {
    await withDemo(2, async (tx) => {
      await sql`alter table institution_class_categories no force row level security`.execute(tx);
      const rows = await sql<{ code: string; categories: string[] }>`
        select i.code, array_agg(c.code order by c.display_order) as categories
        from institution_class_categories o
        join institutions i on i.id = o.institution_id
        join class_categories c on c.id = o.class_category_id
        where o.institution_id in (${sql.join(classesOffered.map((offer) => sql`${offer.institutionId}`))})
        group by i.code order by i.code
      `.execute(tx);
      expect(rows.rows).toEqual([
        { code: 'LPS', categories: ['LOWER_PRIMARY', 'HIGHER_PRIMARY', 'HIGH_SCHOOL'] },
        { code: 'SVHS', categories: ['LOWER_PRIMARY', 'HIGHER_PRIMARY', 'HIGH_SCHOOL'] },
        { code: 'SVPS', categories: ['PRE_SCHOOL', 'NURSERY', 'LOWER_PRIMARY'] },
      ]);
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

  it('gives every Institution a rate, and Sri Vidya High School a revised one, and writes each once', async () => {
    await withDemo(2, async (tx) => {
      const rows = await sql<{ code: string; amount: string; effective: string }>`
        select i.code, r.rate_per_student_amount as amount, r.effective_from_date as effective
        from institution_price_rates r join institutions i on i.id = r.institution_id
        where r.id in (${sql.join(rates.map((r) => sql`${r.id}`))})
        order by i.code, r.effective_from_date
      `.execute(tx);
      expect(rows.rows).toEqual([
        { code: 'LPS', amount: '55.00', effective: '2026-04-01' },
        { code: 'SVHS', amount: '60.00', effective: '2026-04-01' },
        { code: 'SVHS', amount: '65.00', effective: '2026-10-01' },
        { code: 'SVPS', amount: '45.00', effective: '2026-04-01' },
      ]);
    });
  });

  it('raises six dues, numbered from 1, with the amounts the rate gives and every state shown, and the next live due is number 7', async () => {
    await withDemo(2, async (tx) => {
      const rows = await sql<{
        invoice: string;
        code: string;
        start: string;
        total: string;
        rate: string;
        status: number;
        paid: string | null;
        mode: number | null;
        reference: string | null;
        cancelled: boolean;
        reason: string | null;
      }>`
        select d.invoice_no as invoice, i.code, d.period_start_date as start, d.total_amount as total,
          d.rate_per_student_amount as rate, d.due_status as status, d.paid_date as paid,
          d.payment_mode as mode, d.payment_reference as reference,
          d.cancelled_by is not null and d.cancelled_at is not null as cancelled, d.cancel_reason as reason
        from platform_dues d join institutions i on i.id = d.institution_id
        where d.id in (${sql.join(dues.map((d) => sql`${d.id}`))})
        order by d.invoice_no
      `.execute(tx);
      const open = { paid: null, mode: null, reference: null, cancelled: false, reason: null };
      expect(rows.rows).toEqual([
        {
          ...open,
          invoice: 'BNX/FY2026-27/0001',
          code: 'SVHS',
          start: '2026-04-01',
          total: '18000.00',
          rate: '60.00',
          status: 2,
          paid: '2026-05-10',
          mode: 2,
          reference: 'UTR 4821',
        },
        {
          ...open,
          invoice: 'BNX/FY2026-27/0002',
          code: 'SVHS',
          start: '2026-10-01',
          total: '19500.00',
          rate: '65.00',
          status: 1,
        },
        {
          ...open,
          invoice: 'BNX/FY2026-27/0003',
          code: 'SVPS',
          start: '2026-04-01',
          total: '8000.00',
          rate: '45.00',
          status: 1,
        },
        {
          ...open,
          invoice: 'BNX/FY2026-27/0004',
          code: 'LPS',
          start: '2026-04-01',
          total: '13750.00',
          rate: '55.00',
          status: 2,
          paid: '2026-05-12',
          mode: 3,
          reference: 'UPI 90417',
        },
        {
          ...open,
          invoice: 'BNX/FY2026-27/0005',
          code: 'LPS',
          start: '2026-10-01',
          total: '13750.00',
          rate: '55.00',
          status: 1,
        },
        {
          ...open,
          invoice: 'BNX/FY2026-27/0006',
          code: 'SVPS',
          start: '2026-04-01',
          total: '8100.00',
          rate: '45.00',
          status: 0,
          cancelled: true,
          reason: 'Raised twice by mistake',
        },
      ]);
      const counter = await sql<{ next: number }>`
        select next_value as next from number_sequences
        where sequence_type = 3 and period_key = 'FY2026-27'`.execute(tx);
      expect(counter.rows).toEqual([{ next: 7 }]);
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
