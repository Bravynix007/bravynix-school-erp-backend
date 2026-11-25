import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { ExamPaperRepository } from './exam-paper.repository.js';

const repository = new ExamPaperRepository();

describe('ExamPaperRepository', () => {
  it('lists the active papers of an exam in the order they are sat', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.ofExam(tx, 'exam-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"exam_id" = $1 and "status" = $2');
    expect(sql).not.toContain('"section_id" =');
    expect(sql).toMatch(/order by "exam_date", "start_time", "section_id"$/);
    expect(parameters).toEqual(['exam-1', 1]);
  });

  it('narrows the list to one section', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.ofExam(tx, 'exam-1', 'section-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('and "section_id" = $3');
    expect(parameters).toEqual(['exam-1', 1, 'section-1']);
  });

  it('finds a paper by its own row, locking only when it is about to change', async () => {
    const plain = sqlRecorder();
    await repository.find(plain.tx, 'paper-1');
    expect(plain.queries[0]!.sql).not.toContain('for update');
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'paper-1', true);
    expect(locked.queries[0]!.sql).toMatch(/where "id" = \$1 for update$/);
  });

  it('asks whether an active paper falls outside the dates', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.anyOutside(tx, 'exam-1', '2026-08-10', '2026-08-14');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"exam_id" = $1 and "status" = $2');
    expect(sql).toContain('("exam_date" < $3 or "exam_date" > $4)');
    expect(parameters).toEqual(['exam-1', 1, '2026-08-10', '2026-08-14', 1]);
  });

  it('lists the papers a staff member marks or invigilates, with the exam’s name, in the order they are sat', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.ofStaff(tx, 'year-1', 'staff-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('inner join "exams" as "e" on "e"."id" = "p"."exam_id"');
    expect(sql).toContain('"e"."name" as "exam_name"');
    expect(sql).toContain('"p"."status" = $2 and "e"."status" = $3');
    expect(sql).toContain(
      '("p"."subject_teacher_staff_member_id" = $4 or "p"."invigilator_staff_member_id" = $5)',
    );
    expect(sql).toMatch(/order by "p"."exam_date", "p"."start_time", "p"."id"$/);
    expect(parameters).toEqual(['year-1', 1, 1, 'staff-1', 'staff-1']);
  });

  it('asks whether the exam still has an active paper', async () => {
    const { tx, queries } = sqlRecorder();
    expect(await repository.anyActive(tx, 'exam-1')).toBe(false);
    expect(queries[0]!.sql).toContain('"exam_id" = $1 and "status" = $2');
  });
});
