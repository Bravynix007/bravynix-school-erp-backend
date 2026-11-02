import type { AuditValues } from '../../platform/audit/index.js';
import type { ClassRow } from './class.repository.js';
import type { SectionRow } from './section.repository.js';

/** What the audit log keeps of a class. */
export function classAuditView(row: ClassRow): AuditValues {
  return {
    predefined_class_id: row.predefined_class_id,
    stream_name: row.stream_name,
    display_name: row.display_name,
    code: row.code,
    status: row.status,
  };
}

/** What the audit log keeps of a section. */
export function sectionAuditView(row: SectionRow): AuditValues {
  return {
    class_id: row.class_id,
    predefined_section_id: row.predefined_section_id,
    display_name: row.display_name,
    capacity: row.capacity,
    status: row.status,
  };
}
