import type { Tx } from '../../platform/database/index.js';

/**
 * What the modules above People ask of it about staff: who the caller is as a staff member, and the names of teachers.
 * The staff records belong to People, which provides this once for Attendance, Timetable and Diary (SDD 9.3 rules 1 and
 * 7). Every call runs in the caller's transaction, under row-level security.
 */
export abstract class StaffDirectory {
  /** The active staff record of this person, or `undefined` for a person who is not staff of the caller's Society. */
  abstract ownRecord(
    tx: Tx,
    personId: string,
  ): Promise<{ staffMemberId: string; homeInstitutionId: string } | undefined>;

  /** The names of these teachers (first and last), by staff ID, as the caller's scope shows them. */
  abstract names(tx: Tx, staffMemberIds: readonly string[]): Promise<Map<string, string>>;

  /** The names of these teachers for a parent's request: only the teachers of the child's Institution, and only names. */
  abstract namesForParent(tx: Tx, staffMemberIds: readonly string[]): Promise<Map<string, string>>;
}
