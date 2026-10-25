import type { ColumnType, Generated } from 'kysely';

type Json = string | null;

/**
 * Kysely type of `audit_logs` (DDD 9.12). Rows are only ever inserted, so
 * every column is write-once. JSON values are passed as serialised text.
 */
export interface AuditLogsTable {
  id: string;
  created_at: ColumnType<Date, Date | string, never>;
  society_id: string | null;
  institution_id: string | null;
  actor_user_id: string | null;
  actor_role_code: number | null;
  actor_display_name: string | null;
  via_support_access: Generated<boolean>;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  outcome: Generated<number>;
  reason: string | null;
  request_id: string | null;
  ip_address: ColumnType<string | null, string | null, never>;
  user_agent: string | null;
  old_values: ColumnType<unknown, Json, never>;
  new_values: ColumnType<unknown, Json, never>;
}
