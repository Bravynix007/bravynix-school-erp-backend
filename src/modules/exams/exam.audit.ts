import type { AuditValues } from '../../platform/audit/index.js';
import type { ExamRow } from './exam.repository.js';

/** What the audit log keeps of an exam. */
export function examAuditView(row: ExamRow): AuditValues {
  return {
    academic_year_id: row.academic_year_id,
    name: row.name,
    exam_type: row.exam_type,
    start_date: row.start_date,
    end_date: row.end_date,
    datesheet_published_at: row.datesheet_published_at?.toISOString() ?? null,
    status: row.status,
  };
}
