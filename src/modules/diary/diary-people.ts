import type { Tx } from '../../platform/database/index.js';

/** One person to tell about a diary entry, and the child it is for. */
export interface DiaryReceiver {
  userId: string;
  studentId: string;
}

/**
 * What Diary asks of People: who the writer is, what they may write, the names of teachers, where a child sits and who
 * guards the children of a section. The staff records, the assignments, the placements and the guardians belong to
 * People, which provides this (SDD 9.3 rules 1 and 7). Every call runs in the caller's transaction, under row-level
 * security.
 */
export abstract class DiaryPeople {
  /** The active staff record of this person, or `undefined` for a person who is not staff of the caller's Society. */
  abstract ownRecord(
    tx: Tx,
    personId: string,
  ): Promise<{ staffMemberId: string; homeInstitutionId: string } | undefined>;

  /**
   * Whether the teacher may write for this subject in this section in the year (PRD 7.9, Phase 5 decision 6): they
   * teach the subject there, or they lead the section as its class teacher (any subject).
   */
  abstract mayWrite(
    tx: Tx,
    staffMemberId: string,
    academicYearId: string,
    sectionId: string,
    subjectId: string,
  ): Promise<boolean>;

  /** The names of these teachers (first and last), by staff ID, as the caller's scope shows them. */
  abstract names(tx: Tx, staffMemberIds: readonly string[]): Promise<Map<string, string>>;

  /** The names of these teachers for a parent's request: only the teachers of the child's Institution, and only names. */
  abstract namesForParent(tx: Tx, staffMemberIds: readonly string[]): Promise<Map<string, string>>;

  /** The section the child sits in now, or `undefined` for a child with no open placement. */
  abstract currentSectionId(tx: Tx, studentId: string): Promise<string | undefined>;

  /** The people with a login who guard the students placed in the section on the date, each with the child. */
  abstract receiversOf(tx: Tx, sectionId: string, date: string): Promise<DiaryReceiver[]>;
}
