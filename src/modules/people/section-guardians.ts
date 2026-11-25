import type { Tx } from '../../platform/database/index.js';
import type { StudentRepository } from './student.repository.js';

/** One person with a login who guards a child, and the child. */
export interface GuardianReceiver {
  userId: string;
  studentId: string;
}

/** The people with a login who guard the students placed in the section on the date, each with the child. */
export async function guardianReceiversOf(
  students: StudentRepository,
  tx: Tx,
  sectionId: string,
  date: string,
): Promise<GuardianReceiver[]> {
  const placed = await students.placedOn(tx, sectionId, date);
  const guardians = await students.guardianUsersByEnrolment(
    tx,
    placed.map((student) => student.studentEnrolmentId),
  );
  return placed.flatMap((student) =>
    (guardians.get(student.studentEnrolmentId) ?? []).map((userId) => ({
      userId,
      studentId: student.studentId,
    })),
  );
}
