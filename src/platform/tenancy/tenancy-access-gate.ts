import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { BlockSection } from '../../common/auth/block-section.js';
import { TenantAccessGate } from '../../common/auth/tenant-access-gate.js';
import { isStaffRole, stoppingSection } from './access-block.rules.js';
import { ScopeService } from './scope.service.js';

/**
 * Reads the blocks of the Society of the caller's active context, once per
 * request, and decides whether one of them stops the caller's role
 * (`stoppingSection`). The read does not go through row-level security, so a
 * caller whose tenant would hide the block is stopped all the same.
 *
 * Staff roles also need the Institutions they reach; the Owner needs only the
 * blocks, so the Owner's calls cost one read.
 */
@Injectable()
export class TenancyAccessGate extends TenantAccessGate {
  constructor(private readonly scope: ScopeService) {
    super();
  }

  async blockedSection(principal: Principal): Promise<BlockSection | null> {
    if (principal.societyId === null) return null;
    const blocks = await this.scope.activeBlocks(principal);
    if (!isStaffRole(principal.roleCode)) return stoppingSection(principal.roleCode, blocks, []);
    const { institutions } = await this.scope.forPrincipal(principal);
    return stoppingSection(
      principal.roleCode,
      blocks,
      institutions.map((institution) => institution.id),
    );
  }
}
