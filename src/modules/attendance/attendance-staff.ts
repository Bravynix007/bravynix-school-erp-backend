import type { Tx } from '../../platform/database/index.js';

/**
 * What Attendance asks of People about the person marking: the teacher or staff member they are, and the Institution
 * that is their home. Only the home Institution lets a teacher mark (PRD 4: extra Institutions are view-only). The
 * staff records belong to People, which provides this (SDD 9.3 rules 1 and 7). Runs in the caller's transaction.
 */
export abstract class AttendanceStaff {
  /** The active staff record of this person, or `undefined` for a person who is not staff of the caller's Society. */
  abstract ownRecord(
    tx: Tx,
    personId: string,
  ): Promise<{ staffMemberId: string; homeInstitutionId: string } | undefined>;
}
