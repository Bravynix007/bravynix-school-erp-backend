import type { Tx } from '../../platform/database/index.js';

/** One student of a section on a day, as the marking screen lists them. */
export interface RosterStudent {
  studentId: string;
  studentEnrolmentId: string;
  rollNumber: string;
  firstName: string;
  lastName: string | null;
  photoFileId: string | null;
}

/** A student by enrolment, as a mark names them. */
export interface MarkedStudent {
  studentId: string;
  firstName: string;
  lastName: string | null;
}

/**
 * What Attendance asks of People: who sits in a section on a day, and who guards them. The placements, the
 * enrolments and the guardians belong to People, which provides this (SDD 9.3 rules 1 and 7). Every call runs in the
 * caller's transaction, under row-level security.
 */
export abstract class SectionRoster {
  /**
   * Everyone whose placement in the section covers the date, whose enrolment is active and had not ended before it
   * (DDD 13.2), by roll number. With `placedBefore`, only those whose placement was made by then: the roster as a
   * session already submitted saw it.
   */
  abstract on(
    tx: Tx,
    sectionId: string,
    date: string,
    placedBefore?: Date,
  ): Promise<RosterStudent[]>;

  /** The students of these enrolments, by enrolment ID. */
  abstract studentsOf(
    tx: Tx,
    studentEnrolmentIds: readonly string[],
  ): Promise<ReadonlyMap<string, MarkedStudent>>;

  /** The people with a login who guard the students of these enrolments, each once, by enrolment ID. */
  abstract guardiansOf(
    tx: Tx,
    studentEnrolmentIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>>;
}
