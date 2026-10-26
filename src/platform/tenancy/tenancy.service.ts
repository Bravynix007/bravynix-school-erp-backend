import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { TenancyRepository } from './tenancy.repository.js';

@Injectable()
export class TenancyService {
  constructor(private readonly repository: TenancyRepository) {}

  /**
   * True when the Institution or its Society is paused. An Institution the
   * caller cannot see counts as paused, never as open.
   */
  async isInstitutionPaused(principal: Principal, institutionId: string): Promise<boolean> {
    const paused = await this.repository.institutionPauseState(
      {
        personId: principal.personId,
        societyId: principal.societyId,
        roleCode: principal.roleCode,
        viaSupportAccess: principal.viaSupportAccess,
      },
      institutionId,
    );
    return paused ?? true;
  }
}
