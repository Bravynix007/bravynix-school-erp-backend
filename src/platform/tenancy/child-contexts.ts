import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { InstitutionContext } from './scope.service.js';

/**
 * Where a parent's read of one of their children runs. The guardians belong to People, which provides this once for
 * every module that has a parent read (SDD 9.3 rules 1 and 7): Events, the period timings, the class timetable.
 */
export abstract class ChildContexts {
  /**
   * The child's Institution and the tenant of the parent's request for them (404 when the child is not theirs, 423
   * `SECTION_BLOCKED` when the Institution has its students blocked, 403 `CHILD_ACCESS_BLOCKED` for a blocked child).
   */
  abstract of(principal: Principal, studentId: string): Promise<InstitutionContext>;
}
