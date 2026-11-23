import type { Tx } from '../../platform/database/index.js';

/**
 * What Timetable asks of People about a teacher of a lesson. The staff records belong to People, which provides this (SDD 9.3 rules
 * 1 and 7). Every call runs in the caller's transaction, under row-level security.
 */
export abstract class TimetableStaff {
  /**
   * The teacher of a lesson at this Institution: found (404 otherwise), active (422 `REFERENCE_INACTIVE` on
   * `staffMemberId`), not blocked (422 `STAFF_BLOCKED`), with this Institution as home (422 `STAFF_NOT_AT_INSTITUTION`,
   * as an extra Institution is view-only), and able to teach the subject (422 `SUBJECT_NOT_TAUGHT`).
   */
  abstract requireTeacher(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    subjectId: string,
  ): Promise<void>;
}
