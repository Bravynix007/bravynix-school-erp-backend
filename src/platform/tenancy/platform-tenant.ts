import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import type { TenantContext } from '../database/index.js';

/**
 * Super Admin reaches the tenant roots as a platform operator (DDD 15.3). A
 * change names its Society (and Institution) too: the audit entry carries
 * their IDs so the Society's owners see it (API design 20.3), and the audit
 * policy admits only the Society and Institutions the request is acting in.
 */
export function platformTenant(
  principal: Principal,
  societyId?: string,
  institutionIds?: readonly string[],
): TenantContext {
  // The policy guard already limits these routes to Super Admin; row-level
  // security would otherwise trust this context, so the role is checked again here.
  if (principal.roleCode !== RoleCode.SuperAdmin) throw AppException.forbidden();
  return { personId: principal.personId, roleCode: RoleCode.SuperAdmin, societyId, institutionIds };
}
