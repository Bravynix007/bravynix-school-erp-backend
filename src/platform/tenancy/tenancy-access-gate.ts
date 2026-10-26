import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { TenantAccessGate } from '../../common/auth/tenant-access-gate.js';
import { ScopeService } from './scope.service.js';
import { TenancyRepository } from './tenancy.repository.js';

/**
 * Reads the pause on the Society of the caller's active context, once per
 * request, through row-level security.
 *
 * It fails closed: a Society the caller cannot see counts as paused, so a
 * dangling or foreign `active_society_id` never opens the door.
 *
 * An Institution Admin is also stopped when every Institution they reach is
 * paused (PRD 9.4), because nothing is left for them to work in. With one still
 * open they pass, and a call naming a paused Institution gets 423 from the
 * tenant scope check (`ScopeService.requireInstitution`). The Society Owner
 * runs the whole Society and is stopped only by a Society pause.
 */
@Injectable()
export class TenancyAccessGate extends TenantAccessGate {
  constructor(
    private readonly repository: TenancyRepository,
    private readonly scope: ScopeService,
  ) {
    super();
  }

  async isPaused(principal: Principal): Promise<boolean> {
    if (principal.societyId === null) return false;
    const paused = await this.repository.societyPauseState(
      {
        personId: principal.personId,
        societyId: principal.societyId,
        roleCode: principal.roleCode,
        viaSupportAccess: principal.viaSupportAccess,
      },
      principal.societyId,
    );
    if (paused ?? true) return true;
    if (principal.roleCode !== RoleCode.InstitutionAdmin) return false;
    const { institutions } = await this.scope.forPrincipal(principal);
    return institutions.length > 0 && institutions.every((institution) => institution.paused);
  }
}
