import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { AssignmentRepository, type TeachingFilter } from './assignment.repository.js';

const now = new Date('2026-11-10T09:00:00Z');
const filter = (fields: Partial<TeachingFilter> = {}): TeachingFilter => ({
  institutionId: 'institution-1',
  academicYearId: 'year-1',
  ...fields,
});

/** The dummy driver returns no rows, so a call that needs one ends in an error after its SQL was recorded. */
const sqlOf = async (work: (tx: ReturnType<typeof sqlRecorder>['tx']) => Promise<unknown>) => {
  const { tx, queries } = sqlRecorder();
  await work(tx).catch(() => undefined);
  return queries;
};

describe('AssignmentRepository', () => {
  const repository = new AssignmentRepository();

  it('reads the class-teacher rows that still hold, in the order they were made', async () => {
    const [query] = await sqlOf((tx) => repository.classTeacherOf(tx, 'staff-1'));
    expect(query?.sql).toContain('from "class_teacher_assignments"');
    expect(query?.sql).toContain('"ended_at" is null');
    expect(query?.sql).toContain('order by "created_at", "id"');
    expect(query?.parameters).toEqual(['staff-1']);
  });

  it('ends one row only while it is still active, and sets nothing but the two ended columns', async () => {
    const [lead] = await sqlOf((tx) => repository.endClassTeacher(tx, 'row-1', 'person-1', now));
    expect(lead?.sql).toMatch(
      /^update "class_teacher_assignments" set "ended_at" = \$1, "ended_by" = \$2/,
    );
    expect(lead?.sql).toContain('"ended_at" is null');
    expect(lead?.parameters).toEqual([now, 'person-1', 'row-1']);
    const [teaching] = await sqlOf((tx) => repository.endTeaching(tx, 'row-2', 'person-1', now));
    expect(teaching?.sql).toMatch(
      /^update "teaching_assignments" set "ended_at" = \$1, "ended_by" = \$2/,
    );
    expect(teaching?.parameters).toEqual([now, 'person-1', 'row-2']);
  });

  it('ends every active row of a staff member in both tables, and counts them', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.endAllOfStaff(tx, 'staff-1', 'person-1', now).catch(() => undefined);
    expect(queries.map((q) => q.sql.split(' set ')[0])).toEqual([
      'update "class_teacher_assignments"',
      'update "teaching_assignments"',
    ]);
    for (const query of queries) {
      expect(query.sql).toContain('"ended_at" is null');
      expect(query.parameters).toEqual([now, 'person-1', 'staff-1']);
    }
  });

  it('reads one assignment, locked only when it is about to end', async () => {
    const [plain] = await sqlOf((tx) => repository.findTeaching(tx, 'row-1'));
    expect(plain?.sql).not.toContain('for update');
    const [locked] = await sqlOf((tx) => repository.findTeaching(tx, 'row-1', true));
    expect(locked?.sql).toContain('for update');
    expect(locked?.parameters).toEqual(['row-1']);
  });

  it('reads the sections of a year from the active rows of both tables, once each', async () => {
    const [query] = await sqlOf((tx) => repository.activeSectionIds(tx, 'staff-1', 'year-1'));
    expect(query?.sql).toContain('from class_teacher_assignments');
    expect(query?.sql).toContain('from teaching_assignments');
    expect(query?.sql).toContain('union');
    expect(query?.sql.match(/ended_at is null/g)).toHaveLength(2);
    expect(query?.parameters).toEqual(['staff-1', 'year-1', 'staff-1', 'year-1']);
  });

  it('reads the years of an Institution in which the staff member has an active assignment', async () => {
    const [query] = await sqlOf((tx) => repository.activeYearIds(tx, 'staff-1', 'institution-1'));
    expect(query?.sql.match(/ended_at is null/g)).toHaveLength(2);
    expect(query?.sql.match(/institution_id =/g)).toHaveLength(2);
    expect(query?.parameters).toEqual(['staff-1', 'institution-1', 'staff-1', 'institution-1']);
  });

  it('reads the active class teachers of the sections in a year, with their names', async () => {
    const [query] = await sqlOf((tx) =>
      repository.classTeachersOf(tx, 'year-1', ['section-1', 'section-2']),
    );
    expect(query?.sql).toContain('inner join "staff_members"');
    expect(query?.sql).toContain('"a"."ended_at" is null');
    expect(query?.sql).toContain('"a"."section_id" in ($2, $3)');
    expect(query?.parameters).toEqual(['year-1', 'section-1', 'section-2']);
  });

  describe('pageTeaching', () => {
    it('lists the active assignments of the Institution and year by teacher name, a page at a time', async () => {
      const [list] = await sqlOf((tx) => repository.pageTeaching(tx, filter(), 10, 20));
      expect(list?.sql).toContain('inner join "staff_members" on');
      expect(list?.sql).toContain('"a"."ended_at" is null');
      // The order of the staff list (STF-01): one spelling of "by name" for both.
      expect(list?.sql).toContain(
        `order by lower(concat_ws(' ', staff_members.first_name, staff_members.last_name)), "a"."created_at", "a"."id"`,
      );
      expect(list?.parameters).toEqual(['institution-1', 'year-1', 10, 20]);
    });

    it('adds a condition for each filter that is given, and none otherwise', async () => {
      const [plain] = await sqlOf((tx) => repository.pageTeaching(tx, filter(), 10, 0));
      for (const column of ['section_id', 'subject_id', 'staff_member_id']) {
        expect(plain?.sql).not.toContain(`"a"."${column}" =`);
      }
      const [all] = await sqlOf((tx) =>
        repository.pageTeaching(
          tx,
          filter({ sectionId: 'section-1', subjectId: 'subject-1', staffMemberId: 'staff-1' }),
          10,
          0,
        ),
      );
      for (const column of ['section_id', 'subject_id', 'staff_member_id']) {
        expect(all?.sql).toContain(`"a"."${column}" =`);
      }
      expect(all?.parameters).toEqual([
        'institution-1',
        'year-1',
        'section-1',
        'subject-1',
        'staff-1',
        10,
        0,
      ]);
    });
  });
});
