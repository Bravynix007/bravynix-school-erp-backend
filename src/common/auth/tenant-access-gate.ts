import type { Principal } from './access-token-verifier.js';
import type { BlockSection } from './block-section.js';

/**
 * Answers which section block, if any, stops the caller (owner decision, 26
 * Oct 2026; API design 6.5). The Tenancy module provides the implementation;
 * the policy guard asks it on every request, so a block takes effect on the
 * next call and a lift on the next after that.
 */
export abstract class TenantAccessGate {
  /** The section whose block stops the principal's active context, or `null`. */
  abstract blockedSection(principal: Principal): Promise<BlockSection | null>;
}
