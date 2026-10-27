import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import type { TenantContext } from '../database/index.js';
import { GrantDirectory } from '../identity/index.js';
import { BlockSection } from '../../common/auth/block-section.js';
import { isStaffRole, staffBlockedIds, type ActiveBlock } from './access-block.rules.js';
import { TenancyRepository } from './tenancy.repository.js';

/** An active Institution the caller's role reaches, and whether its staff are blocked. */
export interface ScopedInstitution {
  id: string;
  staffBlocked: boolean;
}

/**
 * Where the caller may act, resolved once per request (SDD 10.3 step 2): their
 * Society and the active Institutions inside it that their role reaches.
 */
export interface RequestScope {
  personId: string;
  roleCode: RoleCode | null;
  societyId: string | null;
  institutions: readonly ScopedInstitution[];
  /**
   * For Society-wide work: the Society and the Institutions in scope. A Society
   * Owner keeps staff-blocked ones (audit and dues stay readable); an
   * Institution Admin does not, so the database hides a blocked Institution
   * from them too.
   */
  tenant: TenantContext;
}

/** One Institution the caller named and may act in, ready to open a transaction. */
export interface InstitutionContext {
  institutionId: string;
  societyId: string;
  /**
   * Narrowed to this one Institution, so tables keyed on `institution_id` also
   * hide the rest in the database. The `institutions` and `societies` policies
   * are Society-level, so every Institution endpoint must call
   * `requireInstitution` itself.
   */
  tenant: TenantContext;
}

/**
 * Tenant scope, check 2 of 3 (API design 6.4). A record in another Society, or
 * in an Institution the caller does not reach, answers 404 and never admits it
 * exists (SDD 12.4); an Institution whose staff are blocked answers 423 to
 * its staff, and not to the Owner.
 *
 * Roles 2 and 3 only for now: a Society Owner reaches every active Institution
 * of their Society, an Institution Admin those they hold a grant for. Roles 4
 * and 5 reach none until the People module adds their records, so they fail
 * closed. Super Admin has no Society: platform endpoints address Societies and
 * Institutions by ID under the Super Admin policy of row-level security, and do
 * not use this check.
 */
@Injectable()
export class ScopeService {
  /** One principal object lives for one request, so these memoise per request. */
  private readonly resolved = new WeakMap<Principal, Promise<RequestScope>>();
  private readonly blocks = new WeakMap<Principal, Promise<readonly ActiveBlock[]>>();

  constructor(
    private readonly repository: TenancyRepository,
    private readonly grants: GrantDirectory,
  ) {}

  forPrincipal(principal: Principal): Promise<RequestScope> {
    let scope = this.resolved.get(principal);
    if (!scope) {
      scope = this.resolve(principal);
      this.resolved.set(principal, scope);
    }
    return scope;
  }

  /** The blocks in force in the caller's Society, read once per request. */
  activeBlocks(principal: Principal): Promise<readonly ActiveBlock[]> {
    let blocks = this.blocks.get(principal);
    if (!blocks) {
      blocks =
        principal.societyId === null
          ? Promise.resolve([])
          : this.repository.activeBlocks(principal.societyId, principal.personId);
      this.blocks.set(principal, blocks);
    }
    return blocks;
  }

  /** The caller's Society must be `societyId`; anything else is 404. */
  requireSociety(principal: Principal, societyId: string): string {
    if (principal.societyId === null || principal.societyId !== societyId) {
      throw AppException.notFound();
    }
    return societyId;
  }

  async requireInstitution(
    principal: Principal,
    institutionId: string,
  ): Promise<InstitutionContext> {
    const scope = await this.forPrincipal(principal);
    const found = scope.institutions.find((institution) => institution.id === institutionId);
    if (!found || scope.societyId === null) throw AppException.notFound();
    if (found.staffBlocked && isStaffRole(scope.roleCode)) {
      throw AppException.sectionBlocked(BlockSection.Staff);
    }
    return {
      institutionId,
      societyId: scope.societyId,
      tenant: { ...scope.tenant, institutionIds: [institutionId] },
    };
  }

  private async resolve(principal: Principal): Promise<RequestScope> {
    const { personId, roleCode, societyId } = principal;
    const [ids, blocks] = await Promise.all([
      this.institutionIdsFor(principal),
      this.activeBlocks(principal),
    ]);
    const blocked = staffBlockedIds(blocks);
    const institutions = ids.map((id) => ({ id, staffBlocked: blocked.has(id) }));
    return {
      personId,
      roleCode,
      societyId,
      institutions,
      tenant: {
        personId,
        roleCode,
        societyId,
        institutionIds: institutions
          .filter((institution) => !isStaffRole(roleCode) || !institution.staffBlocked)
          .map((institution) => institution.id),
      },
    };
  }

  private async institutionIdsFor({ personId, roleCode, societyId }: Principal): Promise<string[]> {
    if (societyId === null) return [];
    const tenant: TenantContext = { personId, roleCode, societyId };
    switch (roleCode) {
      case RoleCode.SocietyOwner:
        return this.repository.activeInstitutionIds(tenant, societyId, null);
      case RoleCode.InstitutionAdmin:
        return this.repository.activeInstitutionIds(
          tenant,
          societyId,
          await this.grants.adminInstitutionIds(personId, societyId),
        );
      default:
        return [];
    }
  }
}
