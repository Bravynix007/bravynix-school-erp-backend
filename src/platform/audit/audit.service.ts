import { Injectable } from '@nestjs/common';
import { isIP } from 'node:net';
import { newId } from '../../common/ids/ids.js';
import { RequestContext } from '../../common/request-context/request-context.js';
import { Clock } from '../../common/time/clock.js';
import type { Tx } from '../database/index.js';
import { changedFields, serializeValues, type AuditValues } from './audit-values.js';

export const AuditOutcome = { Success: 1, Denied: 2, Failed: 3 } as const;
export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];

/** `area.verb` or `area.thing.verb`, lower case (DDD 9.12), up to 60 characters. */
const ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export interface AuditActor {
  userId: string | null;
  roleCode: number | null;
  displayName: string | null;
}

export interface AuditEntry {
  /** For example `student.update`, `auth.login`, `access.grant` (API design 20.3). */
  action: string;
  entityType?: string;
  entityId?: string;
  /**
   * The tenant the entry belongs to. Left out, it is the caller's Society;
   * `null` is for entries that belong to no Society (logins, platform actions).
   */
  societyId?: string | null;
  /**
   * The Institution the action happened in, or `null` for a Society-level or
   * person-level action. Required, so an Institution-level action cannot be
   * written as a Society-level row by forgetting it.
   */
  institutionId: string | null;
  outcome?: AuditOutcome;
  /** Required by the rules that ask for one: cancellations, reveals, support access. */
  reason?: string;
  /** The record before the change, or null for a create. */
  before?: AuditValues | null;
  /** The record after the change, or null for a delete. */
  after?: AuditValues | null;
  viaSupportAccess?: boolean;
  /**
   * Who acted. Left out, it is the caller of this request. A login passes it,
   * because the request has no caller yet.
   */
  actor?: AuditActor;
}

/**
 * Actions that belong to a person or to the platform rather than to one
 * Society, so they may carry no Society even inside a tenant request. Any
 * other action in a tenant request needs its Society, or the tenant's own
 * audit view would never show it (API design 20.3).
 */
const SOCIETYLESS_ACTION = /^(auth|platform)\./;

/** The row as inserted; exported so tests can check it without a database. */
export interface AuditRow {
  id: string;
  created_at: Date;
  society_id: string | null;
  institution_id: string | null;
  actor_user_id: string | null;
  actor_role_code: number | null;
  actor_display_name: string | null;
  via_support_access: boolean;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  outcome: number;
  reason: string | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  old_values: string | null;
  new_values: string | null;
}

function control(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/** Builds the row. Pure: the clock, the request context and the ID come in. */
export function buildAuditRow(
  entry: AuditEntry,
  context: ReturnType<typeof RequestContext.current>,
  now: Date,
  id: string,
): AuditRow {
  if (entry.action.length > 60 || !ACTION_PATTERN.test(entry.action)) {
    throw new Error(`Invalid audit action "${entry.action}"`);
  }
  if (entry.reason !== undefined && entry.reason.length > 500) {
    throw new Error('Audit reason is over 500 characters');
  }
  const actor: AuditActor = entry.actor ?? {
    userId: context?.personId ?? null,
    roleCode: context?.roleCode ?? null,
    displayName: context?.displayName ?? null,
  };
  if (entry.societyId === null && context?.societyId && !SOCIETYLESS_ACTION.test(entry.action)) {
    throw new Error(`Audit action "${entry.action}" needs a Society inside a tenant request`);
  }
  const { old: oldValues, new: newValues } = changedFields(entry.before, entry.after);
  // A link-local IPv6 address may carry a zone ("fe80::1%eth0"), which inet refuses.
  const ip = context?.ipAddress?.split('%')[0];
  return {
    id,
    created_at: now,
    society_id: entry.societyId === undefined ? (context?.societyId ?? null) : entry.societyId,
    institution_id: entry.institutionId,
    actor_user_id: actor.userId,
    actor_role_code: actor.roleCode,
    actor_display_name: actor.displayName ? control(actor.displayName).slice(0, 200) : null,
    via_support_access: entry.viaSupportAccess ?? false,
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId ?? null,
    outcome: entry.outcome ?? AuditOutcome.Success,
    reason: entry.reason ?? null,
    request_id: context?.requestId ?? null,
    ip_address: ip && isIP(ip) ? ip : null,
    user_agent: context?.userAgent ? control(context.userAgent).slice(0, 300) : null,
    old_values: serializeValues(oldValues),
    new_values: serializeValues(newValues),
  };
}

/**
 * Writes audit entries (SDD 13.8). It takes the caller's transaction, never
 * its own, so the entry and the change it describes commit or roll back
 * together; an entry that cannot be written fails the change.
 *
 * Row-level security applies: an entry for a Society other than the caller's
 * is refused by the database (DDD 15.3).
 */
@Injectable()
export class AuditService {
  constructor(private readonly clock: Clock) {}

  /**
   * Returns the new entry's ID. The insert must not use `.returning()`: the
   * SELECT policy would apply to the returned row, and an entry with no
   * Society (a login) is not readable by anyone in a tenant session.
   */
  async record(tx: Tx, entry: AuditEntry): Promise<string> {
    const id = newId();
    const row = buildAuditRow(entry, RequestContext.current(), this.clock.now(), id);
    await tx.insertInto('audit_logs').values(row).execute();
    return id;
  }
}
