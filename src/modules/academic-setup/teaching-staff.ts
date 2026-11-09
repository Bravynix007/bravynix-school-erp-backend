import type { Tx } from '../../platform/database/index.js';

/** Who leads a section, as the section lists show them (SEC-01 to SEC-03). */
export interface ClassTeacherRef {
  staffMemberId: string;
  firstName: string;
  lastName: string | null;
}

/**
 * What Academic setup asks of People: which years, sections and subjects a teacher handles, and who leads each
 * section. The assignments belong to People, which already depends on Academic setup, so Academic setup states what
 * it needs here and People provides it (SDD 9.3 rules 1 and 7).
 *
 * "Own" is the teacher's active class-teacher and teaching assignments. Both are kept only at the teacher's home
 * Institution, so at an extra Institution a teacher has none (PRD 4, decision 11). Every call runs in the caller's
 * transaction, under row-level security.
 */
export abstract class TeachingStaff {
  /** The sections the person leads or teaches in the Institution's current year; empty with no current year. */
  abstract ownSectionIds(
    tx: Tx,
    personId: string,
    institutionId: string,
  ): Promise<ReadonlySet<string>>;

  /** The academic years of the Institution in which the person holds an assignment. */
  abstract ownYearIds(
    tx: Tx,
    personId: string,
    institutionId: string,
  ): Promise<ReadonlySet<string>>;

  /** The subjects the person can teach (their own list). */
  abstract ownSubjectIds(tx: Tx, personId: string): Promise<ReadonlySet<string>>;

  /** The class teacher of each of these sections in the Institution's current year; a section with none is left out. */
  abstract classTeachers(
    tx: Tx,
    institutionId: string,
    sectionIds: readonly string[],
  ): Promise<ReadonlyMap<string, ClassTeacherRef>>;
}
