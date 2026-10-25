import type { AuditLogsTable } from '../audit/audit.tables.js';

/**
 * Kysely table types, one interface per table, added by the module that owns
 * the table in the same PR as its migration. Module code only ever touches
 * its own tables (SDD 9.3 rule 1).
 */
export interface Database {
  audit_logs: AuditLogsTable;
}
