import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { Tx, TenantContext } from '../../platform/database/index.js';

/**
 * What Events asks of People: who the people of an audience are, and the tenant in which a parent reads their child's
 * calendar. The staff and guardians belong to People, which provides this (SDD 9.3 rules 1 and 7); every call runs in
 * the caller's transaction, under row-level security.
 */
export abstract class EventPeople {
  /**
   * The people who work in the Society or, with an Institution, there: the Owners, the Admins and the Teachers and
   * Staff, each once.
   */
  abstract staffUserIds(
    tx: Tx,
    societyId: string,
    institutionId: string | null,
  ): Promise<readonly string[]>;

  /**
   * The people who guard an active student of the Institution, or of the whole Society for none, each once. With
   * predefined classes only those who guard a student now placed in a class made from one of them.
   */
  abstract parentUserIds(
    tx: Tx,
    institutionId: string | null,
    predefinedClassIds: readonly string[],
  ): Promise<readonly string[]>;

  /** The tenant of a parent's request for one of their children (404, 423 or 403 when the child is not open to them). */
  abstract childTenant(principal: Principal, studentId: string): Promise<TenantContext>;
}
