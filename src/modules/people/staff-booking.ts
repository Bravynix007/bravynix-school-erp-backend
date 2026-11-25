import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import type { Tx } from '../../platform/database/index.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';

/**
 * A staff member another module books for a duty at an Institution (a lesson, a paper to invigilate): found (404
 * otherwise), active (422 `REFERENCE_INACTIVE` on `field`), not blocked (422 `STAFF_BLOCKED`) and with this Institution
 * as home (422 `STAFF_NOT_AT_INSTITUTION`, as an extra Institution is view-only).
 */
export async function requireBookableStaff(
  staff: StaffRepository,
  tx: Tx,
  staffMemberId: string,
  institutionId: string,
  field: string,
): Promise<StaffRow> {
  const member = await staff.find(tx, staffMemberId);
  if (!member) throw AppException.notFound();
  if (member.status === 0) throw AppException.referenceInactive(field);
  if (member.access_blocked_at !== null) throw AppException.businessRule(ErrorCode.STAFF_BLOCKED);
  if (member.home_institution_id !== institutionId) {
    throw AppException.businessRule(ErrorCode.STAFF_NOT_AT_INSTITUTION);
  }
  return member;
}

/** The same, for a teacher of a subject: they must also be able to teach it (422 `SUBJECT_NOT_TAUGHT`). */
export async function requireBookableTeacher(
  staff: StaffRepository,
  tx: Tx,
  staffMemberId: string,
  institutionId: string,
  subjectId: string,
  field: string,
): Promise<void> {
  const teacher = await requireBookableStaff(staff, tx, staffMemberId, institutionId, field);
  if (!(await staff.subjectIds(tx, teacher.id)).includes(subjectId)) {
    throw AppException.businessRule(ErrorCode.SUBJECT_NOT_TAUGHT);
  }
}
