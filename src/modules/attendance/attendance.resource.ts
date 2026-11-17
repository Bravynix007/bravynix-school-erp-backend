import type { PersonRef } from '../../platform/identity/index.js';
import type { SessionRow } from './attendance.repository.js';
import type { MarkedStudent, RosterStudent } from './section-roster.js';

/** The person who submitted, as the screens say "Marked by". */
export interface SubmitterRef {
  id: string;
  displayName: string;
}

/** The section and its class, by name. */
export interface SectionRef {
  id: string;
  displayName: string;
  classId: string;
  className: string;
}

/** One session of a section and day, with the counts (API design 10.11). */
export interface AttendanceSessionResource {
  id: string;
  institutionId: string;
  sectionId: string;
  sectionName: string | null;
  className: string | null;
  attendanceDate: string;
  version: number;
  rosterCount: number;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  halfDayCount: number;
  leaveCount: number;
  submittedBy: SubmitterRef;
  submittedAt: string;
}

/** ATT-04: a session with the students who were not Present. */
export interface AttendanceSessionDetailResource extends AttendanceSessionResource {
  marks: {
    studentEnrolmentId: string;
    studentId: string;
    firstName: string | null;
    lastName: string | null;
    attendanceStatus: number;
  }[];
}

/** ATT-01: the students of a section on a day, with any session already submitted (API design 10.10). */
export interface RosterResource {
  section: SectionRef;
  date: string;
  isHoliday: boolean;
  holidayTitle: string | null;
  canMark: boolean;
  existingSession: {
    id: string;
    version: number;
    submittedBy: SubmitterRef;
    submittedAt: string;
  } | null;
  students: (RosterStudent & { attendanceStatus: number })[];
}

function submitter(row: SessionRow, people: ReadonlyMap<string, PersonRef>): SubmitterRef {
  const person = people.get(row.submitted_by);
  return { id: row.submitted_by, displayName: person?.displayName ?? 'Unknown' };
}

export function sessionResource(
  row: SessionRow,
  sections: ReadonlyMap<string, { displayName: string; className: string }>,
  people: ReadonlyMap<string, PersonRef>,
): AttendanceSessionResource {
  const section = sections.get(row.section_id);
  return {
    id: row.id,
    institutionId: row.institution_id,
    sectionId: row.section_id,
    sectionName: section?.displayName ?? null,
    className: section?.className ?? null,
    attendanceDate: row.attendance_date,
    version: row.version,
    rosterCount: row.roster_count,
    presentCount: row.present_count,
    absentCount: row.absent_count,
    lateCount: row.late_count,
    halfDayCount: row.half_day_count,
    leaveCount: row.leave_count,
    submittedBy: submitter(row, people),
    submittedAt: row.submitted_at.toISOString(),
  };
}

export function sessionDetailResource(
  row: SessionRow,
  marks: readonly { studentEnrolmentId: string; attendanceStatus: number }[],
  students: ReadonlyMap<string, MarkedStudent>,
  sections: ReadonlyMap<string, { displayName: string; className: string }>,
  people: ReadonlyMap<string, PersonRef>,
): AttendanceSessionDetailResource {
  return {
    ...sessionResource(row, sections, people),
    marks: marks.map((mark) => {
      const student = students.get(mark.studentEnrolmentId);
      return {
        studentEnrolmentId: mark.studentEnrolmentId,
        studentId: student?.studentId ?? '',
        firstName: student?.firstName ?? null,
        lastName: student?.lastName ?? null,
        attendanceStatus: mark.attendanceStatus,
      };
    }),
  };
}

export function existingSessionOf(
  row: SessionRow,
  people: ReadonlyMap<string, PersonRef>,
): NonNullable<RosterResource['existingSession']> {
  return {
    id: row.id,
    version: row.version,
    submittedBy: submitter(row, people),
    submittedAt: row.submitted_at.toISOString(),
  };
}
