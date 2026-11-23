import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { AttendanceRepository } from './attendance.repository.js';

describe('AttendanceRepository.sessionsOfSections', () => {
  const repository = new AttendanceRepository();

  it('reads the active sessions of the sections between two days', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.sessionsOfSections(tx, ['section-1', 'section-2'], '2026-06-01', '2026-11-30');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('from "attendance_sessions"');
    expect(sql).toContain(
      '"section_id" in ($1, $2) and "attendance_date" >= $3 and "attendance_date" <= $4 and "status" = $5',
    );
    expect(parameters).toEqual(['section-1', 'section-2', '2026-06-01', '2026-11-30', 1]);
  });

  it('reads nothing for no section', async () => {
    const { tx, queries } = sqlRecorder();
    expect(await repository.sessionsOfSections(tx, [], '2026-06-01', '2026-11-30')).toEqual([]);
    expect(queries).toEqual([]);
  });
});

describe('AttendanceRepository.marksOfEnrolments', () => {
  const repository = new AttendanceRepository();

  it('reads the exceptions of the enrolments between two days, those of active sessions only', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.marksOfEnrolments(tx, ['enrolment-1'], '2026-06-01', '2026-11-30');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain(
      'from "attendance_exceptions" as "x" inner join "attendance_sessions" as "s"',
    );
    expect(sql).toContain(
      '"s"."id" = "x"."attendance_session_id" and "s"."attendance_date" = "x"."attendance_date"',
    );
    expect(sql).toContain(
      '"x"."student_enrolment_id" in ($1) and "x"."attendance_date" >= $2 and "x"."attendance_date" <= $3 and "s"."status" = $4',
    );
    expect(parameters).toEqual(['enrolment-1', '2026-06-01', '2026-11-30', 1]);
  });

  it('reads nothing for no enrolment', async () => {
    const { tx, queries } = sqlRecorder();
    expect(await repository.marksOfEnrolments(tx, [], '2026-06-01', '2026-11-30')).toEqual([]);
    expect(queries).toEqual([]);
  });
});
