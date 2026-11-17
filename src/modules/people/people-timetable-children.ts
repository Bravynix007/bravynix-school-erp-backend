import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { InstitutionContext } from '../../platform/tenancy/index.js';
import { TimetableChildren } from '../timetable/index.js';
import { ChildAccess } from './child-access.js';

/** What People tells Timetable (`TimetableChildren`): a parent's context for one of their children. */
@Injectable()
export class PeopleTimetableChildren extends TimetableChildren {
  constructor(private readonly access: ChildAccess) {
    super();
  }

  childContext(principal: Principal, studentId: string): Promise<InstitutionContext> {
    return this.access.of(principal, studentId);
  }
}
