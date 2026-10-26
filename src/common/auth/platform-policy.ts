import { Policy } from './policy.decorator.js';
import { RoleCode } from './roles.js';

/** The policy of every `/v1/platform` route that only Super Admin may call (API design 9.2). */
export const superAdminPolicy = (operationId: string, rule: string) =>
  Policy({ roles: [RoleCode.SuperAdmin], scope: 'platform', operationId, rule });
