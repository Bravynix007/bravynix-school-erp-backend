import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { Database, Tx } from '../../platform/database/index.js';
import { DueRepository, type NewDue } from './due.repository.js';

interface Logged {
  sql: string;
  parameters: readonly unknown[];
}

/** A Kysely that runs nothing and records the SQL it was asked to run. */
function recorder() {
  const queries: Logged[] = [];
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') {
        queries.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });
  return { tx: db as unknown as Tx, queries };
}

/** The dummy driver returns no rows, so a call that needs one ends in an error after its SQL was recorded. */
const ignoringNoRows = (work: Promise<unknown>) => work.catch(() => undefined);

describe('DueRepository', () => {
  const repository = new DueRepository();

  /** The SQL a page asks for: the list, then the count. */
  const page = async (filter: object, sort: { field: string; direction: 'asc' | 'desc' }[]) => {
    const { tx, queries } = recorder();
    await ignoringNoRows(
      repository.page(tx, filter, sort as Parameters<DueRepository['page']>[2], 10, 20),
    );
    return queries;
  };

  it('inserts the values and reads the row back in the same statement', async () => {
    const { tx, queries } = recorder();
    await ignoringNoRows(
      repository.insert(tx, { invoice_no: 'BNX/FY2026-27/0001', created_by: 'p' } as NewDue),
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toMatch(/^insert into "platform_dues" .* returning \*$/);
    expect(queries[0]!.parameters).toEqual(['BNX/FY2026-27/0001', 'p']);
  });

  it('finds one due by its ID', async () => {
    const { tx, queries } = recorder();
    expect(await repository.find(tx, 'due-1')).toBeUndefined();
    expect(queries[0]).toEqual({
      sql: 'select * from "platform_dues" where "id" = $1',
      parameters: ['due-1'],
    });
  });

  describe('page', () => {
    it('asks for everything, in the sort, the ID as the last key, and the page', async () => {
      const [rows] = await page({}, [{ field: 'createdAt', direction: 'desc' }]);
      expect(rows!.sql).toBe(
        'select * from "platform_dues" where 1 = 1 order by "platform_dues"."created_at" desc, "platform_dues"."id" limit $1 offset $2',
      );
      expect(rows!.parameters).toEqual([10, 20]);
    });

    it('filters by Society, Institution, status and a part of the invoice number, in the list and in the count', async () => {
      const queries = await page(
        { q: 'FY2026_', societyId: 's', institutionId: 'i', statuses: [1, 2] },
        [
          { field: 'totalAmount', direction: 'desc' },
          { field: 'invoiceNo', direction: 'asc' },
        ],
      );
      expect(queries).toHaveLength(2);
      for (const query of queries) {
        expect(query.sql).toContain('"invoice_no" ilike $1');
        expect(query.sql).toContain('"society_id" = $2');
        expect(query.sql).toContain('"institution_id" = $3');
        expect(query.sql).toContain('"due_status" in ($4, $5)');
        // A wildcard in the text is matched as itself.
        expect(query.parameters.slice(0, 5)).toEqual(['%FY2026\\_%', 's', 'i', 1, 2]);
      }
      expect(queries[0]!.sql).toContain(
        'order by "platform_dues"."total_amount" desc, "platform_dues"."invoice_no" asc, "platform_dues"."id"',
      );
      expect(queries[1]!.sql).toContain('count(*)');
    });

    it('leaves a status list that is empty out of the filter', async () => {
      const [rows] = await page({ statuses: [] }, [{ field: 'dueDate', direction: 'asc' }]);
      expect(rows!.sql).not.toContain('due_status');
    });
  });
});
