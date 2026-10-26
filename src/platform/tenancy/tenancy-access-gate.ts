import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { TenantAccessGate } from '../../common/auth/tenant-access-gate.js';
import { TenancyRepository } from './tenancy.repository.js';

/**
 * Reads the pause on the Society of the caller's active context, once per
 * request, through row-level security.
 *
 * It fails closed: a Society the caller cannot see counts as paused, so a
 * dangling or foreign `active_society_id` never opens the door. A pause on a
 * single Institution is checked where the request names the Institution, in
 * the tenant scope check (`TenancyService.isInstitutionPaused`).
 */
@Injectable()
export class TenancyAccessGate extends TenantAccessGate {
  constructor(private readonly repository: TenancyRepository) {
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
    return paused ?? true;
  }
}
