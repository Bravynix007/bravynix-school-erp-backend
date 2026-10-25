import type { ColumnType, Generated } from 'kysely';

/** Kysely types of the Identity tables (DDD 9.1). */

export interface UsersTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  version: Generated<number>;
  email: string;
  first_name: string | null;
  last_name: string | null;
  country_code: string | null;
  phone_number: string | null;
  account_status: Generated<number>;
  preferred_language: Generated<string>;
  failed_login_count: Generated<number>;
  locked_until: Date | null;
  first_login_at: Date | null;
  last_login_at: Date | null;
  blocked_at: Date | null;
  blocked_by: string | null;
  block_reason: string | null;
}

export interface RoleAssignmentsTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  user_id: string;
  role_code: number;
  society_id: string | null;
  institution_id: string | null;
  staff_member_id: string | null;
  seat_no: number | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

export interface OtpChallengesTable {
  id: string;
  created_at: ColumnType<Date, Date, never>;
  email_hmac: Buffer;
  user_id: string | null;
  code_hmac: Buffer | null;
  purpose: Generated<number>;
  expires_at: Date;
  attempt_count: Generated<number>;
  consumed_at: Date | null;
  superseded_at: Date | null;
  request_ip: ColumnType<string | null, string | null, never>;
  /** Set when failed attempts lock the email (also for an email with no account). */
  locked_until: Date | null;
}

export interface PublicCallCountersTable {
  ip: string;
  window_start: Date;
  calls: number;
  created_at: Generated<Date>;
}

export interface AuthSessionsTable {
  id: string;
  created_at: Generated<Date>;
  user_id: string;
  client_type: number;
  active_role_code: number | null;
  active_society_id: string | null;
  last_used_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date | null;
  ended_at: Date | null;
  end_reason: number | null;
  ip_address: ColumnType<string | null, string | null, never>;
  user_agent: string | null;
  device_label: string | null;
}

export interface RefreshTokensTable {
  id: string;
  created_at: Generated<Date>;
  session_id: string;
  token_hmac: Buffer;
  expires_at: Date;
  used_at: Date | null;
}
