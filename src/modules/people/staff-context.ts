import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import { DatabaseService } from '../../platform/database/index.js';
import { ScopeService, type InstitutionContext } from '../../platform/tenancy/index.js';
import { StaffRepository } from './staff.repository.js';

/**
 * The Institution context of a request about one staff member (STF-03 to STF-13, ASG-02): the record's home
 * Institution, which the caller must reach.
 */
@Injectable()
export class StaffContext {
  constructor(
    private readonly database: DatabaseService,
    private readonly staff: StaffRepository,
    private readonly scope: ScopeService,
  ) {}

  /**
   * 404 for a record that does not exist, is at no Institution the caller reaches, or (for a teacher) is not their
   * own: a record the caller may not see is answered as if it did not exist (SDD 12.4).
   */
  async of(principal: Principal, id: string): Promise<InstitutionContext> {
    const scope = await this.scope.forPrincipal(principal);
    const home = await this.database.transaction(scope.tenant, async (tx) => {
      const found = await this.staff.find(tx, id);
      // A teacher reaches their own record and nobody else's, as if the others did not exist.
      if (principal.roleCode === RoleCode.TeacherStaff && found?.user_id !== principal.personId) {
        return undefined;
      }
      return found?.home_institution_id;
    });
    if (!home) throw AppException.notFound();
    return this.scope.requireInstitution(principal, home);
  }
}
