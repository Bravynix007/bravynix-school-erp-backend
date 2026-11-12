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
    expect(await page({ inSectionIds: [] })).toEqual([]);
    expect(await page({ inYearIds: [] })).toEqual([]);
    const { tx } = recorder();
    expect(await repository.page(tx, filter({ institutionIds: [] }), [], 10, 0)).toEqual({
      rows: [],
      total: 0,
    });
  });

  it('keeps to the Institutions and statuses asked for, in the list and in the count', async () => {
    const [list, count] = await page({});
    for (const query of [list!, count!]) {
      expect(query.sql).toContain('"students"."institution_id" in ($2, $3)');
      expect(query.sql).toContain('"students"."status" in ($4)');
      expect(query.parameters.slice(1, 4)).toEqual(['institution-1', 'institution-2', 1]);
    }
    expect(list!.sql).toMatch(/limit \$\d+ offset \$\d+$/);
    expect(count!.sql).toContain('count(*) as "total"');
  });

  it('keeps to the sections given, in the list and in the count', async () => {
    const [list, count] = await page({ inSectionIds: ['section-1', 'section-2'] });
    for (const query of [list!, count!]) {
      expect(query.sql).toContain('"pl"."section_id" in (');
      expect(query.parameters).toEqual(expect.arrayContaining(['section-1', 'section-2']));
    }
  });

  it('shows the latest placement of the student, or the one of the year asked for', async () => {
    const [latest] = await page({});
    expect(latest!.sql).toContain('inner join lateral');
    expect(latest!.sql).toContain('"e"."student_id" = "students"."id"');
    expect(latest!.sql).not.toContain('"e"."status"');
    expect(latest!.sql).toContain('order by "p"."start_date" desc, "p"."id" desc limit $1');
    expect(latest!.sql).not.toContain('"p"."academic_year_id" = ');
    const [year, count] = await page({ academicYearId: 'year-1' });
    for (const query of [year!, count!]) {
      expect(query.sql).toContain('"p"."academic_year_id" = $1');
      expect(query.parameters[0]).toBe('year-1');
    }
  });

  it('filters by class and section of the placement shown, in the list and in the count', async () => {
    const [list, count] = await page({ classId: 'class-1', sectionId: 'section-1' });
    for (const query of [list!, count!]) {
      expect(query.sql).toContain('"pl"."class_id" = $5');
      expect(query.sql).toContain('"pl"."section_id" = $6');
      expect(query.parameters.slice(4, 6)).toEqual(['class-1', 'section-1']);
    }
  });

  it('searches the name, the Admission ID and the roll number, lower case, with the wildcards escaped', async () => {
    const [list] = await page({ q: '50%_X' });
    expect(list!.sql).toContain('"students"."search_text" like $5');
    expect(list!.sql).toContain('lower(pl.roll_number) like $6');
    expect(list!.parameters.slice(4, 6)).toEqual(['%50\\%\\_x%', '%50\\%\\_x%']);
  });

  it('searches only the name and roll number for the classroom view, never the Admission ID', async () => {
    const [list] = await page({ q: 'adm', searchNameAndRollOnly: true });
    expect(list!.sql).not.toContain('search_text');
    expect(list!.sql).toContain(
      "lower(students.first_name || ' ' || coalesce(students.last_name, '')) like $5",
    );
  });

  it('keeps the placement to the years given', async () => {
    const [list] = await page({ inYearIds: ['year-1'] });
    expect(list!.sql).toContain('"p"."academic_year_id" in ($1)');
  });

  it.each([
    ['name', 'lower(concat_ws'],
    ['admissionNo', 'lower(students.admission_no)'],
    [
      'rollNumber',
      "case when pl.roll_number ~ '^[0-9]+$' then '0' || lpad(pl.roll_number, 20, '0') else '1' || lower(pl.roll_number) end",
    ],
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

  it('reads the latest placement of the student, even when the enrolment was cancelled', async () => {
    const { tx, queries } = recorder();
    await repository.placedNow(tx, 'student-1');
    expect(queries[0]!.sql).toContain('"e"."student_id" = $1');
    expect(queries[0]!.sql).not.toContain('"e"."status"');
    expect(queries[0]!.sql).toContain('order by "p"."start_date" desc, "p"."id" desc limit $2');
    expect(queries[0]!.parameters).toEqual(['student-1', 1]);
  });

  it('reads the open placement of an active enrolment: the one a move closes', async () => {
    const { tx, queries } = recorder();
    await repository.openPlacement(tx, 'student-1');
    expect(queries[0]!.sql).toContain(
      '"e"."student_id" = $1 and "e"."status" = $2 and "p"."end_date" is null',
    );
    expect(queries[0]!.parameters).toEqual(['student-1', 1]);
  });

  it('changes a student, an enrolment and a placement by ID', async () => {
    const { tx, queries } = recorder();
    await repository.update(tx, 'student-1', { first_name: 'Ravi' }).catch(() => undefined);
    await repository.updateEnrolment(tx, 'enrolment-1', { status: 0 });
    await repository.updatePlacement(tx, 'placement-1', { end_date: '2026-07-01' });
    expect(queries.map((query) => query.sql)).toEqual([
      expect.stringMatching(/^update "students" set "first_name" = \$1 where "id" = \$2 returning/),
      'update "student_enrolments" set "status" = $1 where "id" = $2',
      'update "student_section_placements" set "end_date" = $1 where "id" = $2',
    ]);
  });

  it('counts the open placements of a section in a year, and only those', async () => {
    const { tx, queries } = recorder();
    await repository.sectionCount(tx, 'year-1', 'section-1').catch(() => undefined);
    expect(queries[0]!.sql).toContain(
      '"academic_year_id" = $1 and "section_id" = $2 and "end_date" is null',
    );
    expect(queries[0]!.parameters).toEqual(['year-1', 'section-1']);
  });

  it('counts the open placements of each section, in any year, and leaves out a section with none', async () => {
    const { tx, queries } = recorder();
    await repository.sectionCounts(tx, ['section-1', 'section-2']).catch(() => undefined);
    expect(queries[0]!.sql).toContain('"section_id" in ($1, $2) and "end_date" is null');
    expect(queries[0]!.sql).toContain('group by "section_id"');
    expect(queries[0]!.parameters).toEqual(['section-1', 'section-2']);
    const none = recorder();
    expect(await repository.sectionCounts(none.tx, [])).toEqual(new Map());
    expect(none.queries).toEqual([]);
  });

  describe('promotion', () => {
    const source = { academicYearId: 'year-1', classId: 'class-1', sectionId: null };

    it('finds the active students with an open placement in the class, and locks their rows', async () => {
      const { tx, queries } = recorder();
      expect(await repository.promotable(tx, source)).toEqual([]);
      const { sql, parameters } = queries[0]!;
      expect(sql).toContain('"s"."status" = $1 and "e"."status" = $2 and "p"."end_date" is null');
      expect(sql).toContain('"p"."academic_year_id" = $3 and "p"."class_id" = $4');
      expect(sql).not.toContain('"p"."section_id" =');
      expect(sql).toMatch(/for update of "s", "e"$/);
      expect(parameters).toEqual([1, 1, 'year-1', 'class-1']);
    });

    it('narrows to a section and to the students named', async () => {
      const { tx, queries } = recorder();
      await repository.promotable(tx, {
        ...source,
        sectionId: 'section-1',
        studentIds: ['a', 'b'],
      });
      const { sql, parameters } = queries[0]!;
      expect(sql).toContain('"p"."section_id" = $5');
      expect(sql).toContain('"s"."id" in ($6, $7)');
      expect(parameters).toEqual([1, 1, 'year-1', 'class-1', 'section-1', 'a', 'b']);
    });

    it('asks which students hold an active enrolment in the year, and nothing for nobody', async () => {
      const { tx, queries } = recorder();
      expect(await repository.enrolledIn(tx, 'year-2', ['a', 'b'])).toEqual(new Set());
      expect(queries[0]!.sql).toContain(
        '"status" = $1 and "academic_year_id" = $2 and "student_id" in ($3, $4)',
      );
      expect(queries[0]!.parameters).toEqual([1, 'year-2', 'a', 'b']);
      const none = recorder();
      expect(await repository.enrolledIn(none.tx, 'year-2', [])).toEqual(new Set());
      expect(none.queries).toEqual([]);
    });

    it('reads the roll numbers of the open placements of a section in a year', async () => {
      const { tx, queries } = recorder();
      expect(await repository.rollNumbersIn(tx, 'year-2', 'section-2')).toEqual([]);
      expect(queries[0]!.sql).toContain(
        '"academic_year_id" = $1 and "section_id" = $2 and "end_date" is null',
      );
      expect(queries[0]!.parameters).toEqual(['year-2', 'section-2']);
    });
  });
});
