import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { TimetableEntryRepository } from './timetable-entry.repository.js';

const repository = new TimetableEntryRepository();

describe('TimetableEntryRepository', () => {
  it('finds an entry by its own row, locking only when it is about to change', async () => {
    const plain = sqlRecorder();
    await repository.find(plain.tx, 'entry-1');
    expect(plain.queries[0]!.sql).not.toContain('for update');
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'entry-1', true);
    expect(locked.queries[0]!.sql).toMatch(/where "id" = \$1 for update$/);
  });

  it('asks for what holds a day and period by the section or by the teacher, as the column says', async () => {
    const section = sqlRecorder();
    await repository.taken(section.tx, 'section_id', 'section-1', 3, 'slot-1');
    expect(section.queries[0]!.sql).toContain('"section_id" = $1 and "day_of_week" = $2');
    expect(section.queries[0]!.sql).toContain('"status" = $4');
    expect(section.queries[0]!.sql).not.toContain('"id" !=');
    expect(section.queries[0]!.parameters).toEqual(['section-1', 3, 'slot-1', 1]);

    const teacher = sqlRecorder();
    await repository.taken(teacher.tx, 'staff_member_id', 'staff-1', 3, 'slot-1', 'entry-1');
    expect(teacher.queries[0]!.sql).toContain('"staff_member_id" = $1');
    expect(teacher.queries[0]!.sql).toContain('"id" != $5');
    expect(teacher.queries[0]!.parameters).toEqual(['staff-1', 3, 'slot-1', 1, 'entry-1']);
  });
});
