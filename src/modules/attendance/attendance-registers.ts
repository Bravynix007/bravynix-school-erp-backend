import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { AttendanceRepository } from './attendance.repository.js';

/**
 * What Attendance tells People about the registers it holds: whether a student's days in a section have been taken.
 * The sessions stay private to Attendance (SDD 9.3 rule 1). Runs in the caller's transaction, under row-level security.
 */
@Injectable()
export class AttendanceRegisters {
  constructor(private readonly repository: AttendanceRepository) {}

  /**
   * The latest day on or after `from` for which the section's attendance was taken with a student counted, the student
   * having been placed in the section at `placedAt`; `undefined` when there is none. Leaving the section from a day
   * that is on or before it would take the student off a register already taken.
   */
  latestTakenDay(
    tx: Tx,
    sectionId: string,
    from: string,
    placedAt: Date,
  ): Promise<string | undefined> {
    return this.repository.latestTakenDay(tx, sectionId, from, placedAt);
  }
}
