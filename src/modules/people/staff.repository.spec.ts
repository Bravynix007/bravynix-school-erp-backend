import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { Database, Tx } from '../../platform/database/index.js';
import { StaffRepository, type StaffFilter } from './staff.repository.js';

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

const filter = (fields: Partial<StaffFilter> = {}): StaffFilter => ({
  institutionIds: ['institution-1', 'institution-2'],
  statuses: [1],
  ...fields,
});

describe('StaffRepository.page', () => {
  const repository = new StaffRepository();

  /** The SQL a page asks for: the list, then the count. */
  const page = async (
    fields: Partial<StaffFilter>,
    sort: Parameters<StaffRepository['page']>[2] = [{ field: 'name', direction: 'asc' }],
  ) => {
    const { tx, queries } = recorder();
    await repository.page(tx, filter(fields), sort, 10, 20).catch(() => undefined);
    return queries;
  };

  it('reads nothing when there is no Institution or no status to look in', async () => {
    expect(await page({ institutionIds: [] })).toEqual([]);
    expect(await page({ statuses: [] })).toEqual([]);
    const { tx } = recorder();
    expect(await repository.page(tx, filter({ institutionIds: [] }), [], 10, 0)).toEqual({
      rows: [],
      total: 0,
    });
  });

  it('keeps to the home Institutions and the statuses asked for, in the list and in the count', async () => {
    const [list, count] = await page({});
    for (const query of [list!, count!]) {
      expect(query.sql).toContain('"staff_members"."home_institution_id" in ($1, $2)');
      expect(query.sql).toContain('"staff_members"."status" in ($3)');
      expect(query.parameters.slice(0, 3)).toEqual(['institution-1', 'institution-2', 1]);
    }
    expect(list!.sql).toMatch(/limit \$\d+ offset \$\d+$/);
    expect(count!.sql).toContain('count(*) as "total"');
  });

  it('searches the whole name and the Employee ID, with the wildcards of the text escaped', async () => {
    const [list] = await page({ q: '50%_x' });
    expect(list!.sql).toContain(
      "concat_ws(' ', staff_members.first_name, staff_members.last_name) ilike $4",
    );
    expect(list!.sql).toContain('"staff_members"."employee_code" ilike $5');
    expect(list!.parameters.slice(3, 5)).toEqual(['%50\\%\\_x%', '%50\\%\\_x%']);
  });

  it('filters by designation and class category', async () => {
    const [list] = await page({ designationId: 'designation-1', classCategoryId: 'category-1' });
    expect(list!.sql).toContain('"staff_members"."designation_id" = $4');
    expect(list!.sql).toContain('"staff_members"."class_category_id" = $5');
    expect(list!.parameters.slice(3, 5)).toEqual(['designation-1', 'category-1']);
  });

  it('filters by block, with the staff who are blocked or who are not', async () => {
    const [blocked] = await page({ blocked: true });
    expect(blocked!.sql).toContain('"staff_members"."access_blocked_at" is not null');
    const [open] = await page({ blocked: false });
    expect(open!.sql).toContain('"staff_members"."access_blocked_at" is null');
    const [any] = await page({});
    expect(any!.sql).not.toContain('access_blocked_at');
  });

  it('filters by a subject the person can teach, in the list and in the count', async () => {
    const [list, count] = await page({ subjectId: 'subject-1' });
    for (const query of [list!, count!]) {
      expect(query.sql).toContain('from "staff_subjects"');
      expect(query.sql).toContain('"staff_subjects"."staff_member_id" = "staff_members"."id"');
      expect(query.sql).toContain('"staff_subjects"."subject_id" = $4');
      expect(query.parameters[3]).toBe('subject-1');
    }
  });

  it.each([
    ['name', 'lower(concat_ws'],
    ['employeeCode', 'lower(staff_members.employee_code)'],
    ['joiningDate', 'staff_members.joining_date'],
    ['createdAt', 'staff_members.created_at'],
  ] as const)(
    'sorts by %s, nulls last in both directions, and by ID at the end',
    async (field, column) => {
      for (const direction of ['asc', 'desc'] as const) {
        const [list] = await page({}, [{ field, direction }]);
        expect(list!.sql).toContain(`order by ${column}`);
        expect(list!.sql).toContain(`${direction} nulls last, "staff_members"."id"`);
      }
    },
  );
});
