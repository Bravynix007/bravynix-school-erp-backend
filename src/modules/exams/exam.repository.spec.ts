import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { ExamRepository } from './exam.repository.js';

const repository = new ExamRepository();

describe('ExamRepository', () => {
  it('lists the active exams of a year, the earliest first', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.active(tx, 'year-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"academic_year_id" = $1 and "status" = $2');
    expect(sql).toMatch(/order by "start_date", "name"$/);
    expect(parameters).toEqual(['year-1', 1]);
  });

  it('finds an exam by its own row, locking only when it is about to change', async () => {
    const plain = sqlRecorder();
    await repository.find(plain.tx, 'exam-1');
    expect(plain.queries[0]!.sql).not.toContain('for update');
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'exam-1', true);
    expect(locked.queries[0]!.sql).toMatch(/where "id" = \$1 for update$/);
  });
});
