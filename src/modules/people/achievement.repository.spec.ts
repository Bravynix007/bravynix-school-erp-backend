import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { AchievementRepository } from './achievement.repository.js';

const repository = new AchievementRepository();

describe('AchievementRepository', () => {
  it('lists the active stars of a student through the enrolment, newest first', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.ofStudent(tx, 'student-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain(
      'inner join "student_enrolments" as "e" on "e"."id" = "a"."student_enrolment_id"',
    );
    expect(sql).toContain('"e"."student_id" = $1 and "a"."status" = $2');
    expect(sql).toContain('order by "a"."created_at" desc, "a"."id" desc');
    expect(parameters).toEqual(['student-1', 1]);
  });

  it('keeps one year’s stars when a year is named', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.ofStudent(tx, 'student-1', 'year-1');
    expect(queries[0]!.sql).toContain('"a"."academic_year_id" = $3');
    expect(queries[0]!.parameters).toEqual(['student-1', 1, 'year-1']);
  });

  it('finds a star by its own row, locking only that row when it is about to change', async () => {
    const plain = sqlRecorder();
    expect(await repository.find(plain.tx, 'star-1')).toBeUndefined();
    expect(plain.queries[0]!.sql).not.toContain('for update');
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'star-1', true);
    expect(locked.queries[0]!.sql).toMatch(
      /from "student_achievements" where "id" = \$1 for update$/,
    );
  });

  it('removes by status and author, and changes nothing else', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.remove(tx, 'star-1', 'admin-1');
    expect(queries[0]!.sql).toMatch(
      /^update "student_achievements" set "status" = \$1, "updated_by" = \$2 where "id" = \$3$/,
    );
    expect(queries[0]!.parameters).toEqual([0, 'admin-1', 'star-1']);
  });

  it('inserts one star and returns it', async () => {
    const { tx, queries } = sqlRecorder();
    await expect(
      repository.insert(tx, {
        society_id: 's',
        institution_id: 'i',
        academic_year_id: 'y',
        student_enrolment_id: 'e',
        tier: 1,
        description: 'Quiz',
        awarded_by_staff_member_id: null,
      }),
    ).rejects.toThrow('no result');
    expect(queries[0]!.sql).toMatch(/^insert into "student_achievements"/);
    expect(queries[0]!.sql).toMatch(/returning \*$/);
  });
});
