import type { Principal } from './access-token-verifier.js';

/**
 * Answers whether the caller's tenant has been paused by Super Admin (PRD 9.4,
 * API design 6.5). The Tenancy module provides the implementation; the policy
 * guard asks it on every request, so a pause takes effect on the next call.
 */
export abstract class TenantAccessGate {
  /** True when the Society of the principal's active context has its access paused. */
  abstract isPaused(principal: Principal): Promise<boolean>;
}
