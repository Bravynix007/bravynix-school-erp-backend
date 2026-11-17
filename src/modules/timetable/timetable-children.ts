import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { Tx } from '../../platform/database/index.js';
import type { InstitutionContext } from '../../platform/tenancy/index.js';

/**
 * What Timetable asks of People: the context in which a parent reads for one of their children. The guardians belong
 * to People, which provides this (SDD 9.3 rules 1 and 7).
 */
export abstract class TimetableChildren {
  /**
   * The child's Institution and the tenant of the parent's request for them (404 when the child is not theirs, 423
   * `SECTION_BLOCKED` when the Institution has its students blocked, 403 `CHILD_ACCESS_BLOCKED` for a blocked child).
   */
  abstract childContext(principal: Principal, studentId: string): Promise<InstitutionContext>;

  /** The section the child sits in now, or `undefined` for a child with no open placement. */
  abstract currentSectionId(tx: Tx, studentId: string): Promise<string | undefined>;
}
