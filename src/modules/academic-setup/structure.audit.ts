import type { AuditEntry, AuditValues } from '../../platform/audit/index.js';
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

/**
 * The audit entry of a change to a section: it carries the Society and the Institution, so the Society's Owners see
 * it (API design 20.3). Made here so a section closed with its class is recorded exactly as one closed alone.
 */
export function sectionAuditEntry(
  action: string,
  row: SectionRow,
  values: { before?: AuditValues; after?: AuditValues },
): AuditEntry {
  return {
    action,
    institutionId: row.institution_id,
    societyId: row.society_id,
    entityType: 'section',
    entityId: row.id,
    ...values,
  };
}
