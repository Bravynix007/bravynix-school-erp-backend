import type { Tx } from '../../platform/database/index.js';
import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { AttendanceRegisters } from './attendance-registers.js';
import { AttendanceRepository } from './attendance.repository.js';

describe('AttendanceRegisters', () => {
  it('asks the repository for the latest taken day of the section from the day, since the placement', async () => {
    const latestTakenDay = vi
      .fn<AttendanceRepository['latestTakenDay']>()
      .mockResolvedValue('2026-11-17');
    const registers = new AttendanceRegisters({
      latestTakenDay,
    } as unknown as AttendanceRepository);
    const placedAt = new Date('2026-11-01T05:00:00.000Z');
    const tx = {} as Tx;
    expect(await registers.latestTakenDay(tx, 'section-1', '2026-11-12', placedAt)).toBe(
      '2026-11-17',
    );
    expect(latestTakenDay).toHaveBeenCalledWith(tx, 'section-1', '2026-11-12', placedAt);
  });
});

describe('AttendanceRepository.latestTakenDay', () => {
  it('reads the latest active session of the section from the day on, submitted after the placement was made', async () => {
    const { tx, queries } = sqlRecorder();
    const placedAt = new Date('2026-11-01T05:00:00.000Z');
    await new AttendanceRepository()
      .latestTakenDay(tx, 'section-1', '2026-11-12', placedAt)
      .catch(() => undefined);
    const [query] = queries;
    expect(query?.sql).toContain('max("attendance_date")');
    expect(query?.sql).toContain('from "attendance_sessions"');
    expect(query?.sql).toContain('"section_id" = $1');
    expect(query?.sql).toContain('"status" = $2');
    expect(query?.sql).toContain('"attendance_date" >= $3');
    expect(query?.sql).toContain("date_trunc('milliseconds', submitted_at) >= $4");
    expect(query?.parameters).toEqual(['section-1', 1, '2026-11-12', placedAt]);
  });
});
