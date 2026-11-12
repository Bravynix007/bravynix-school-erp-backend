import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../../platform/audit/index.js';
import {
  DatabaseService,
  isDuplicateOn,
  type TenantContext,
  type Tx,
} from '../../platform/database/index.js';
import {
  IdentityNumbers,
  maskAadhaar,
  type ProtectedAadhaar,
} from '../../platform/identity-numbers/index.js';
import type { RevealIdentityDto, SetIdentityDto } from './identity.dto.js';
import { IdentityRepository } from './identity.repository.js';
import {
  identityResource,
  maskedAadhaar,
  type IdentityResource,
  type RevealResource,
} from './identity.resource.js';
import { sameNumber } from './identity.rules.js';
import { StaffContext } from './staff-context.js';
import { StaffRepository, type StaffRow } from './staff.repository.js';

/** The unique index that keeps one record per number in a Society (DDD 9.5). */
const ONE_RECORD_PER_NUMBER = 'uq_staff_identities_society_aadhaar';

/**
 * STF-11 and STF-12 (API design 6.8, 10.9): a staff member's Aadhaar number. It is written, never read back: STF-11
 * answers with the masked number, and the whole number comes only from STF-12, which is limited and audited.
 */
@Injectable()
export class StaffIdentityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly staff: StaffRepository,
    private readonly context: StaffContext,
    private readonly identities: IdentityRepository,
    private readonly numbers: IdentityNumbers,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * STF-11: sets the Aadhaar number, or clears it with `null`. 422 `INVALID_AADHAAR` for a number that is not one;
   * 409 `AADHAAR_EXISTS_IN_SOCIETY` when another active record of the Society holds it, without naming that record
   * (the record of a deactivated staff member gives its number up to the new claim, audited as `identity.released`).
   * The same number again, or clearing nothing, writes nothing. 404 when the staff member is deactivated.
   */
  async set(principal: Principal, id: string, body: SetIdentityDto): Promise<IdentityResource> {
    const context = await this.context.of(principal, id);
    const claim =
      body.aadhaar === null
        ? null
        : this.numbers.protect(body.aadhaar, { table: 'staff_identities', rowId: id });
    const tenant = await this.reaching(context.tenant, id, claim);
    return this.database
      .transaction(tenant, async (tx) => {
        const current = await this.context.lockedActive(tx, id);
        const before = await this.identities.find(tx, id);
        if (sameNumber(before, claim)) return identityResource(before);
        if (claim) await this.releaseHolder(tx, tenant, current, claim, principal.personId);
        const slot = { staffMemberId: id, societyId: current.society_id, by: principal.personId };
        await this.identities.put(tx, slot, claim);
        await this.audit.record(tx, {
          action: claim ? 'identity.updated' : 'identity.cleared',
          institutionId: current.home_institution_id,
          entityType: 'staff_identities',
          entityId: id,
          before: { aadhaarMasked: maskedAadhaar(before) },
          after: { aadhaarMasked: claim ? maskAadhaar(claim.last4) : null },
        });
        return identityResource(await this.identities.find(tx, id));
      })
      .catch((error: unknown) => {
        if (isDuplicateOn(error, ONE_RECORD_PER_NUMBER)) {
          throw AppException.conflict(ErrorCode.AADHAAR_EXISTS_IN_SOCIETY);
        }
        throw error;
      });
  }

  /**
   * The caller's tenant, widened by the home Institution of a deactivated record that holds the number, so that the
   * entry of its release can be written at that Institution, where its admins will look for it (the caller may not
   * reach it). Society-level tables are read the same either way; nothing else changes.
   */
  private async reaching(
    tenant: TenantContext,
    claimantId: string,
    claim: ProtectedAadhaar | null,
  ): Promise<TenantContext> {
    if (!claim) return tenant;
    const holder = await this.database.transaction(tenant, (tx) =>
      this.identities.holderOf(tx, claim.hmac, claimantId),
    );
    if (holder?.status !== 0) return tenant;
    return {
      ...tenant,
      institutionIds: [...new Set([...(tenant.institutionIds ?? []), holder.homeInstitutionId])],
    };
  }

  /**
   * An active record that holds the number refuses it (409); a deactivated one gives it up, audited at its own
   * Institution (at the claimant's in the rare case that it was deactivated since `reaching` looked).
   */
  private async releaseHolder(
    tx: Tx,
    tenant: TenantContext,
    claimant: StaffRow,
    claim: ProtectedAadhaar,
    by: string,
  ): Promise<void> {
    const holder = await this.identities.holderOf(tx, claim.hmac, claimant.id);
    if (!holder) return;
    if (holder.status === 1) throw AppException.conflict(ErrorCode.AADHAAR_EXISTS_IN_SOCIETY);
    await this.identities.put(
      tx,
      { staffMemberId: holder.staffMemberId, societyId: claimant.society_id, by },
      null,
    );
    await this.audit.record(tx, {
      action: 'identity.released',
      institutionId: tenant.institutionIds?.includes(holder.homeInstitutionId)
        ? holder.homeInstitutionId
        : claimant.home_institution_id,
      entityType: 'staff_identities',
      entityId: holder.staffMemberId,
      before: { aadhaarMasked: maskAadhaar(claim.last4) },
      after: { aadhaarMasked: null, takenBy: claimant.id },
    });
  }

  /**
   * STF-12: the whole number, for an admin who gives a reason (10 to 500 characters). 404 `NOT_SET` when the record
   * holds no number; 429 `REVEAL_LIMIT` after ten reveals by this admin in an IST day. The entry `identity.reveal`
   * is written before the number is returned and holds the reason, never the number. Allowed for a deactivated
   * record, whose number is still on file.
   */
  async reveal(principal: Principal, id: string, body: RevealIdentityDto): Promise<RevealResource> {
    const context = await this.context.of(principal, id);
    const value = await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.staff.find(tx, id);
      if (!current) throw AppException.notFound();
      const stored = await this.identities.find(tx, id);
      if (!stored?.aadhaar_ciphertext || stored.aadhaar_key_version === null) {
        throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_SET);
      }
      return this.numbers.reveal(tx, {
        slot: { table: 'staff_identities', rowId: id },
        stored: { ciphertext: stored.aadhaar_ciphertext, keyVersion: stored.aadhaar_key_version },
        institutionId: current.home_institution_id,
        reason: body.reason,
      });
    });
    return { field: body.field, value, revealedAt: this.clock.now().toISOString() };
  }
}
