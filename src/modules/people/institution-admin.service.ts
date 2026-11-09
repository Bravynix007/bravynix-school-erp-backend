import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { ApiResult } from '../../common/http/api-result.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { pageMeta, pageOffset } from '../../common/pagination/pagination.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../../platform/audit/index.js';
import { DatabaseService, type Tx } from '../../platform/database/index.js';
import {
  AccountDirectory,
  GrantDirectory,
  type InstitutionAdmin,
} from '../../platform/identity/index.js';
import { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import type { GrantAdminDto, ListAdminsQueryDto } from './institution-admin.dto.js';
import type { InstitutionAdminResource } from './institution-admin.resource.js';
import { StaffRepository, type StaffRow } from './staff.repository.js';

/** Why the grant of an Admin was revoked from the Institution's Admins tab. */
const REVOKED_BY_OWNER = 'revoked_by_owner';

const resource = (institutionId: string, admin: InstitutionAdmin): InstitutionAdminResource => ({
  institutionId,
  staffMemberId: admin.staffMemberId,
  person: admin.person,
  grantedAt: admin.grantedAt.toISOString(),
});

/**
 * INS-08 to INS-10 (API design 10.5): the Society Owner promotes a staff member to Admin of an Institution and takes
 * it away again. The grant is tied to the staff record, so the person must hold an active, unblocked record that
 * reaches the Institution (home or extra, DDD 11.3). Every change runs in one transaction with its audit entry, the
 * record locked, and the mail goes after the commit.
 */
@Injectable()
export class InstitutionAdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly staff: StaffRepository,
    private readonly scope: ScopeService,
    private readonly accounts: AccountDirectory,
    private readonly grants: GrantDirectory,
    private readonly institutions: InstitutionDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** INS-08: the Admins of an Institution of the caller's Society, by name. */
  async list(
    principal: Principal,
    institutionId: string,
    query: ListAdminsQueryDto,
  ): Promise<ApiResult<InstitutionAdminResource[]>> {
    await this.scope.requireInstitution(principal, institutionId);
    const { rows, total } = await this.grants.institutionAdmins(
      institutionId,
      query.limit,
      pageOffset(query.page, query.limit),
    );
    return ApiResult.list(
      rows.map((row) => resource(institutionId, row)),
      pageMeta(query.page, query.limit, total),
    );
  }

  /**
   * INS-09: gives a staff member Admin access to the Institution. 404 for a record that is not in the Society or is
   * deactivated; 422 `STAFF_BLOCKED` for a blocked record, 422 `STAFF_NOT_AT_INSTITUTION` for one that neither has
   * this Institution as home nor as an extra; 409 `ALREADY_ADMIN`; 409 `ACCOUNT_BLOCKED` or `INVALID_STATE` for a
   * person whose account cannot hold a role.
   */
  async grant(
    principal: Principal,
    institutionId: string,
    body: GrantAdminDto,
  ): Promise<InstitutionAdminResource> {
    const context = await this.scope.requireInstitution(principal, institutionId);
    const now = this.clock.now();
    const done = await this.database.transaction(context.tenant, async (tx) => {
      const record = await this.requireGrantable(tx, body.staffMemberId, institutionId);
      const person = await this.accounts.grantInstitutionAdmin(tx, {
        userId: record.user_id,
        societyId: record.society_id,
        institutionId,
        staffMemberId: record.id,
        by: principal.personId,
        now,
      });
      await this.audit.record(tx, {
        action: 'access.grant',
        institutionId,
        entityType: 'staff_member',
        entityId: record.id,
        after: { roleCode: 3, institutionId, personId: person.id },
      });
      const named = await this.institutions.names(tx, [institutionId]);
      return { person, institutionName: named.get(institutionId)?.name ?? '' };
    });
    this.accounts.announceAdminAccess(done.person, 'granted', done.institutionName);
    return {
      institutionId,
      staffMemberId: body.staffMemberId,
      person: { id: done.person.id, displayName: done.person.displayName },
      grantedAt: now.toISOString(),
    };
  }

  /**
   * INS-10: takes the Admin access of a staff member to the Institution away and ends their sessions acting as Admin
   * in the Society. 404 when the record is not in the Society or holds no active grant for the Institution.
   */
  async revoke(principal: Principal, institutionId: string, staffMemberId: string): Promise<void> {
    const context = await this.scope.requireInstitution(principal, institutionId);
    const now = this.clock.now();
    const done = await this.database.transaction(context.tenant, async (tx) => {
      const record = await this.staff.find(tx, staffMemberId, true);
      if (!record) throw AppException.notFound();
      const revoked = await this.accounts.revokeInstitutionAdmin(
        tx,
        record.id,
        institutionId,
        principal.personId,
        REVOKED_BY_OWNER,
        now,
      );
      await this.audit.record(tx, {
        action: 'access.revoke',
        institutionId,
        entityType: 'staff_member',
        entityId: record.id,
        before: { roleCode: 3, institutionId, personId: revoked.id },
        after: { sessionsEnded: revoked.sessionsEnded },
      });
      const named = await this.institutions.names(tx, [institutionId]);
      return { person: revoked, institutionName: named.get(institutionId)?.name ?? '' };
    });
    this.accounts.announceAdminAccess(done.person, 'revoked', done.institutionName);
  }

  /** The record, locked, once it may be promoted at this Institution. */
  private async requireGrantable(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
  ): Promise<StaffRow> {
    const record = await this.staff.find(tx, staffMemberId, true);
    if (!record || record.status === 0) throw AppException.notFound();
    if (record.access_blocked_at !== null) throw AppException.businessRule(ErrorCode.STAFF_BLOCKED);
    const reaches =
      record.home_institution_id === institutionId ||
      (await this.staff.institutionIds(tx, record.id)).includes(institutionId);
    if (!reaches) throw AppException.businessRule(ErrorCode.STAFF_NOT_AT_INSTITUTION);
    return record;
  }
}
