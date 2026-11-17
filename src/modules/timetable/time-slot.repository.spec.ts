import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { TimeSlotRepository } from './time-slot.repository.js';

const repository = new TimeSlotRepository();

describe('TimeSlotRepository', () => {
  it('lists the active periods of a year, earliest first, whatever their numbers', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.active(tx, 'year-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"academic_year_id" = $1 and "status" = $2');
    expect(sql).toMatch(/order by "start_time", "period_no"$/);
    expect(parameters).toEqual(['year-1', 1]);
  });

  it('finds a period by its own row, locking only when it is about to change', async () => {
    const plain = sqlRecorder();
    await repository.find(plain.tx, 'slot-1');
    expect(plain.queries[0]!.sql).not.toContain('for update');
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'slot-1', true);
    expect(locked.queries[0]!.sql).toMatch(/where "id" = \$1 for update$/);
  });
});
