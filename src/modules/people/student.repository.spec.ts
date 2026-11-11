import { sqlRecorder as recorder } from '../../../test/support/sql-recorder.js';
import { StudentRepository, type StudentFilter } from './student.repository.js';

const filter = (fields: Partial<StudentFilter> = {}): StudentFilter => ({
  institutionIds: ['institution-1', 'institution-2'],
  statuses: [1],
  ...fields,
});

describe('StudentRepository.page', () => {
  const repository = new StudentRepository();

  /** The SQL a page asks for: the list, then the count. */
  const page = async (
    fields: Partial<StudentFilter>,
    sort: Parameters<StudentRepository['page']>[2] = [{ field: 'name', direction: 'asc' }],
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

  it('keeps to the Institutions and statuses asked for, in the list and in the count', async () => {
    const [list, count] = await page({});
    for (const query of [list!, count!]) {
      expect(query.sql).toContain('"students"."institution_id" in ($3, $4)');
      expect(query.sql).toContain('"students"."status" in ($5)');
      expect(query.parameters.slice(2, 5)).toEqual(['institution-1', 'institution-2', 1]);
    }
    expect(list!.sql).toMatch(/limit \$\d+ offset \$\d+$/);
    expect(count!.sql).toContain('count(*) as "total"');
  });

  it('shows the latest placement of an active enrolment, or the one of the year asked for', async () => {
    const [latest] = await page({});
    expect(latest!.sql).toContain('inner join lateral');
    expect(latest!.sql).toContain('"e"."student_id" = "students"."id" and "e"."status" = $1');
    expect(latest!.sql).toContain('order by "p"."start_date" desc, "p"."id" desc limit $2');
    expect(latest!.sql).not.toContain('"p"."academic_year_id" = ');
    const [year, count] = await page({ academicYearId: 'year-1' });
    for (const query of [year!, count!]) {
      expect(query.sql).toContain('"p"."academic_year_id" = $2');
      expect(query.parameters[1]).toBe('year-1');
    }
  });

  it('filters by class and section of the placement shown, in the list and in the count', async () => {
    const [list, count] = await page({ classId: 'class-1', sectionId: 'section-1' });
    for (const query of [list!, count!]) {
      expect(query.sql).toContain('"pl"."class_id" = $6');
      expect(query.sql).toContain('"pl"."section_id" = $7');
      expect(query.parameters.slice(5, 7)).toEqual(['class-1', 'section-1']);
    }
  });

  it('searches the name, the Admission ID and the roll number, lower case, with the wildcards escaped', async () => {
    const [list] = await page({ q: '50%_X' });
    expect(list!.sql).toContain('"students"."search_text" like $6');
    expect(list!.sql).toContain('lower(pl.roll_number) like $7');
    expect(list!.parameters.slice(5, 7)).toEqual(['%50\\%\\_x%', '%50\\%\\_x%']);
  });

  it.each([
    ['name', 'lower(concat_ws'],
    ['admissionNo', 'lower(students.admission_no)'],
    ['rollNumber', "(pl.roll_number !~ '^[0-9]+$')::int::text || lpad(pl.roll_number, 20, '0')"],
    ['createdAt', 'students.created_at'],
  ] as const)(
    'sorts by %s, nulls last in both directions, and by ID at the end',
    async (field, column) => {
      for (const direction of ['asc', 'desc'] as const) {
        const [list] = await page({}, [{ field, direction }]);
        expect(list!.sql).toContain(`order by ${column}`);
        expect(list!.sql).toContain(`${direction} nulls last, "students"."id"`);
      }
    },
  );
});

describe('StudentRepository', () => {
  const repository = new StudentRepository();

  it('reads the active guardians of a student, the primary first', async () => {
    const { tx, queries } = recorder();
    await repository.guardians(tx, 'student-1');
    expect(queries[0]!.sql).toContain('"student_id" = $1 and "status" = $2');
    expect(queries[0]!.sql).toContain('order by "is_primary" desc, "created_at", "id"');
    expect(queries[0]!.parameters).toEqual(['student-1', 1]);
  });

  it('reads the latest placement of an active enrolment of the student', async () => {
    const { tx, queries } = recorder();
    await repository.placedNow(tx, 'student-1');
    expect(queries[0]!.sql).toContain('"e"."student_id" = $1 and "e"."status" = $2');
    expect(queries[0]!.sql).toContain('order by "p"."start_date" desc, "p"."id" desc limit $3');
    expect(queries[0]!.parameters).toEqual(['student-1', 1, 1]);
  });

  it('counts the open placements of a section in a year, and only those', async () => {
    const { tx, queries } = recorder();
    await repository.sectionCount(tx, 'year-1', 'section-1').catch(() => undefined);
    expect(queries[0]!.sql).toContain(
      '"academic_year_id" = $1 and "section_id" = $2 and "end_date" is null',
    );
    expect(queries[0]!.parameters).toEqual(['year-1', 'section-1']);
  });
});
