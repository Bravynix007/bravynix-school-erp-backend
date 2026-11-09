import { HttpStatus, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import { RequestContext } from '../../common/request-context/request-context.js';
import { Clock, nextIstMidnight } from '../../common/time/clock.js';
import { AuditService } from '../audit/index.js';
import { SecretBox } from '../crypto/index.js';
import { sql } from 'kysely';
import type { Tx } from '../database/index.js';
import { normaliseAadhaar } from './aadhaar.js';

/** The tables that hold an Aadhaar number (DDD 9.5, 9.6). */
export type IdentityTable = 'staff_identities' | 'student_identities';

/** The row a number belongs to; it is bound into the encryption (DDD 15.6). */
export interface IdentitySlot {
  table: IdentityTable;
  /** `staff_member_id` or `student_id`: the row's own ID. */
  rowId: string;
}

/** What is stored in the `aadhaar_*` columns. */
export interface ProtectedAadhaar {
  ciphertext: Buffer;
  keyVersion: number;
  /** HMAC-SHA-256 of the twelve digits, 32 bytes, for duplicate checks. */
  hmac: Buffer;
  last4: string;
}

/** Reveals one admin may make in an IST day (API design 10.9, Proposed). */
export const REVEAL_LIMIT_PER_DAY = 10;
export const REVEAL_REASON_LENGTH = { min: 10, max: 500 } as const;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The reason as it is audited: trimmed, 10 to 500 characters. 400 `VALIDATION_FAILED` on `reason` otherwise, so a
 * request that got past its DTO is still refused and never becomes a 500. STF-12 and STU-11 use this one rule.
 */
export function requireRevealReason(raw: string): string {
  const reason = raw.trim();
  const { min, max } = REVEAL_REASON_LENGTH;
  if (reason.length >= min && reason.length <= max) return reason;
  const tooShort = reason.length < min;
  const code = tooShort ? FieldErrorCode.TOO_SHORT : FieldErrorCode.TOO_LONG;
  throw AppException.validation([
    { ...fieldError('reason', code), params: tooShort ? { min } : { max } },
  ]);
}

/**
 * Protects the Aadhaar number of a staff member or a student (SDD ADR-09, DDD
 * 15.6): the number is sealed with AES-256-GCM, bound to its table, column and
 * row; a keyed hash finds a second record for the same number; the last four
 * digits are kept for masking. The full number comes back only through
 * `reveal`, which is limited and audited.
 */
@Injectable()
export class IdentityNumbers {
  constructor(
    private readonly box: SecretBox,
    private readonly hmacKey: Buffer,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** @throws AppException 422 INVALID_AADHAAR when `raw` is not a valid number. */
  protect(raw: string, slot: IdentitySlot): ProtectedAadhaar {
    const digits = normaliseAadhaar(raw);
    if (!digits) throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.INVALID_AADHAAR);
    return {
      ciphertext: this.box.seal(Buffer.from(digits, 'ascii'), contextOf(slot)),
      keyVersion: this.box.keyVersion,
      hmac: this.hashOf(digits),
      last4: digits.slice(-4),
    };
  }

  /** The keyed hash of a number already normalised, for looking up a duplicate. */
  hashOf(digits: string): Buffer {
    return createHmac('sha256', this.hmacKey).update(digits, 'ascii').digest();
  }

  /**
   * The full number, for an admin who gave a reason. The entry is written in
   * the caller's transaction before the number is returned, so a reveal that
   * cannot be recorded does not happen. At most {@link REVEAL_LIMIT_PER_DAY} a
   * day for each admin, counted from their own reveal entries in every Society and Institution.
   *
   * The caller answers with the number only after the commit, with `Cache-Control: no-store`, and never logs it
   * (API design 10.9): this returns it inside the transaction, so a failure after this call must not echo it.
   *
   * @throws AppException 429 REVEAL_LIMIT.
   */
  async reveal(tx: Tx, request: RevealRequest): Promise<string> {
    const reason = requireRevealReason(request.reason);
    const actor = RequestContext.current()?.personId;
    if (!actor) throw new Error('A reveal needs a signed-in caller');
    if (request.stored.keyVersion !== this.box.keyVersion) {
      throw new Error(`No key for version ${request.stored.keyVersion}`);
    }

    // The count reads the actor's own entries through `audit_logs_select_own_reveals`, which needs the
    // person in the tenant. Without it the count would be 0 and the limit silently off.
    const { rows: tenant } = await sql<{ person: string | null }>`
      select app_current_person_id() as person
    `.execute(tx);
    if (tenant[0]?.person !== actor)
      throw new Error('A reveal needs its caller as the tenant person');

    // Two reveals at once must not both pass the same count.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`identity.reveal:${actor}`}, 0))`.execute(
      tx,
    );
    const now = this.clock.now();
    const midnight = nextIstMidnight(now);
    const { count } = await tx
      .selectFrom('audit_logs')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('actor_user_id', '=', actor)
      .where('action', '=', 'identity.reveal')
      .where('created_at', '>=', new Date(midnight.getTime() - DAY_MS))
      .executeTakeFirstOrThrow();
    if (Number(count) >= REVEAL_LIMIT_PER_DAY) {
      throw new AppException(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.REVEAL_LIMIT, {
        retryAfterSeconds: Math.ceil((midnight.getTime() - now.getTime()) / 1000),
      });
    }

    const digits = this.box
      .open(request.stored.ciphertext, contextOf(request.slot))
      .toString('ascii');
    await this.audit.record(tx, {
      action: 'identity.reveal',
      entityType: request.slot.table,
      entityId: request.slot.rowId,
      institutionId: request.institutionId,
      reason,
    });
    return digits;
  }
}

export interface RevealRequest {
  slot: IdentitySlot;
  stored: Pick<ProtectedAadhaar, 'ciphertext' | 'keyVersion'>;
  /** The Institution of the staff member's or student's record, or null for a Society-level record. */
  institutionId: string | null;
  reason: string;
}

function contextOf(slot: IdentitySlot): string {
  return `${slot.table}.aadhaar:${slot.rowId}`;
}
