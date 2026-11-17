import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ChildContexts, type InstitutionContext } from '../../platform/tenancy/index.js';
import { ChildAccess } from './child-access.js';

/** What People tells every parent read (`ChildContexts`): the context for one of the parent's children. */
@Injectable()
export class PeopleChildContexts extends ChildContexts {
  constructor(private readonly access: ChildAccess) {
    super();
  }

  of(principal: Principal, studentId: string): Promise<InstitutionContext> {
    return this.access.of(principal, studentId);
  }
}
