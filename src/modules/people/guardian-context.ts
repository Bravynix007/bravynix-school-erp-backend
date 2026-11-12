import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { DatabaseService } from '../../platform/database/index.js';
import { ScopeService, type InstitutionContext } from '../../platform/tenancy/index.js';
import { GuardianRepository } from './guardian.repository.js';
import type { GuardianRow } from './student.repository.js';

/**
 * The Institution context of a request about one guardian (GDN-03, GDN-04): the child's Institution, which the caller
 * must reach, with the guardian as it was read.
 */
@Injectable()
export class GuardianContext {
  constructor(
    private readonly database: DatabaseService,
    private readonly guardians: GuardianRepository,
    private readonly scope: ScopeService,
  ) {}

  /**
   * 404 for a guardian who does not exist or is at no Institution the caller reaches (SDD 12.4). A guardian can read
   * their own rows whichever Institution they are at, so the Institution is checked as well.
   */
  async of(
    principal: Principal,
    guardianId: string,
  ): Promise<{ context: InstitutionContext; guardian: GuardianRow }> {
    const scope = await this.scope.forPrincipal(principal);
    const guardian = await this.database.transaction(scope.tenant, (tx) =>
      this.guardians.find(tx, guardianId),
    );
    if (!guardian) throw AppException.notFound();
    return {
      context: await this.scope.requireInstitution(principal, guardian.institution_id),
      guardian,
    };
  }
}
