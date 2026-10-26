import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import type { TenantContext } from '../database/index.js';
import { GrantDirectory } from '../identity/index.js';
import { TenancyRepository, type ScopedInstitution } from './tenancy.repository.js';

/**
 * Where the caller may act, resolved once per request (SDD 10.3 step 2): their
 * Society and the active Institutions inside it that their role reaches.
 */
export interface RequestScope {
  personId: string;
  roleCode: RoleCode | null;
  societyId: string | null;
  institutions: readonly ScopedInstitution[];
  /** For Society-wide work: the Society and every Institution in scope, paused or not. */
  tenant: TenantContext;
}

/** One Institution the caller named and may act in, ready to open a transaction. */
export interface InstitutionContext {
  institutionId: string;
  societyId: string;
  /** Narrowed to this one Institution, so row-level security repeats the check. */
  tenant: TenantContext;
}

/**
 * Tenant scope, check 2 of 3 (API design 6.4). A record in another Society, or
 * in an Institution the caller does not reach, answers 404 and never admits it
 * exists (SDD 12.4); a paused Institution answers 423.
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
  /** One principal object lives for one request, so this memoises per request. */
  private readonly resolved = new WeakMap<Principal, Promise<RequestScope>>();

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
    if (found.paused) throw AppException.paused();
    return {
      institutionId,
      societyId: scope.societyId,
      tenant: { ...scope.tenant, institutionIds: [institutionId] },
    };
  }

  private async resolve(principal: Principal): Promise<RequestScope> {
    const { personId, roleCode, societyId } = principal;
    const institutions = await this.institutionsFor(principal);
    return {
      personId,
      roleCode,
      societyId,
      institutions,
      tenant: {
        personId,
        roleCode,
        societyId,
        institutionIds: institutions.map((institution) => institution.id),
      },
    };
  }

  private async institutionsFor({
    personId,
    roleCode,
    societyId,
  }: Principal): Promise<ScopedInstitution[]> {
    if (societyId === null) return [];
    const tenant: TenantContext = { personId, roleCode, societyId };
    switch (roleCode) {
      case RoleCode.SocietyOwner:
        return this.repository.activeInstitutions(tenant, societyId, null);
      case RoleCode.InstitutionAdmin:
        return this.repository.activeInstitutions(
          tenant,
          societyId,
          await this.grants.adminInstitutionIds(personId, societyId),
        );
      default:
        return [];
    }
  }
}
