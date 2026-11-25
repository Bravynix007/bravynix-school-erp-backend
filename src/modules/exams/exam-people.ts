import type { Tx } from '../../platform/database/index.js';

/**
 * What Exams asks of People about the staff of a paper. The staff records belong to People, which provides this
 * (SDD 9.3 rules 1 and 7). Every call runs in the caller's transaction, under row-level security. Each call names the
 * field it is about, so a refusal points at the right one.
 */
export abstract class ExamPeople {
  /**
   * The teacher of a paper's subject: found (404 otherwise), active (422 `REFERENCE_INACTIVE` on `field`), not blocked
   * (422 `STAFF_BLOCKED`), with this Institution as home (422 `STAFF_NOT_AT_INSTITUTION`, as an extra Institution is
   * view-only), and able to teach the subject (422 `SUBJECT_NOT_TAUGHT`).
   */
  abstract requireSubjectTeacher(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    subjectId: string,
    field: string,
  ): Promise<void>;

  /** An invigilator: the same as the teacher of a subject, without the subject, since anyone on the staff may invigilate. */
  abstract requireInvigilator(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    field: string,
  ): Promise<void>;
}
