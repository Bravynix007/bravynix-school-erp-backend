import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { Tx } from '../../platform/database/index.js';
import type { InstitutionContext } from '../../platform/tenancy/index.js';

/**
 * A stretch of days a student sat in a section, as the roll of that section counted them (DDD 13.2): the placement,
 * cut short by the day the enrolment ended, and only of an active enrolment.
 */
export interface PlacementSpan {
  studentEnrolmentId: string;
  sectionId: string;
  classId: string;
  startDate: string;
  /** The last day, or `null` while the student sits there still. */
  endDate: string | null;
  /** When the placement was made: a session submitted before it did not have this student on its roll. */
  placedAt: Date;
}

/**
 * What Attendance asks of People for a student's calendar (ATT-07, ATT-08): who may read it, in which context, and
 * where the student sat. The students belong to People, which provides this (SDD 9.3 rules 1 and 7).
 */
export abstract class StudentAttendanceAccess {
  /**
   * The student's Institution context for the caller: an Owner or an Admin of the Institution; a teacher or
   * staff member for a student of their own sections this year (403 `NOT_ASSIGNED`); a parent for their own child
   * (404 for any other, 403 `CHILD_ACCESS_BLOCKED` for a blocked one). 404 for a student out of reach.
   */
  abstract contextOf(principal: Principal, studentId: string): Promise<InstitutionContext>;

  /** Where the student sat in the days from `from` to `to`, earliest first. */
  abstract placementsOf(
    tx: Tx,
    studentId: string,
    from: string,
    to: string,
  ): Promise<PlacementSpan[]>;
}
