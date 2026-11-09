import type { ClassTeacherRow, TeachingView } from './assignment.repository.js';

/** The section a staff member leads in a year (STF-09). */
export interface ClassTeacherResource {
  academicYearId: string;
  sectionId: string;
}

/** One teaching assignment (ASG-01, ASG-02). */
export interface TeachingAssignmentResource {
  id: string;
  institutionId: string;
  academicYearId: string;
  section: { id: string; displayName: string; classId: string; className: string };
  subject: { id: string; name: string };
  staffMember: { id: string; firstName: string; lastName: string | null };
  createdAt: string;
}

export const classTeacherResource = (row: ClassTeacherRow): ClassTeacherResource => ({
  academicYearId: row.academic_year_id,
  sectionId: row.section_id,
});

/** The names come from the Academic setup module, which owns them. */
export function teachingResource(
  row: TeachingView,
  names: { section: { displayName: string; classId: string; className: string }; subject: string },
): TeachingAssignmentResource {
  return {
    id: row.id,
    institutionId: row.institution_id,
    academicYearId: row.academic_year_id,
    section: {
      id: row.section_id,
      displayName: names.section.displayName,
      classId: names.section.classId,
      className: names.section.className,
    },
    subject: { id: row.subject_id, name: names.subject },
    staffMember: {
      id: row.staff_member_id,
      firstName: row.staff_first_name,
      lastName: row.staff_last_name,
    },
    createdAt: row.created_at.toISOString(),
  };
}
