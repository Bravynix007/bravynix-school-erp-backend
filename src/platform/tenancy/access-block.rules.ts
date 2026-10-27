import { BlockSection, SECTION_ROLES } from '../../common/auth/block-section.js';
import { RoleCode } from '../../common/auth/roles.js';

/** One block in force in a Society: `institutionId` is empty for `owners`. */
export interface ActiveBlock {
  section: BlockSection;
  institutionId: string | null;
}

/** Institution Admins and Teachers and Staff: the roles a `staff` block stops. */
export function isStaffRole(roleCode: number | null): boolean {
  return roleCode !== null && SECTION_ROLES[BlockSection.Staff].some((role) => role === roleCode);
}

/** The Institutions of the Society whose staff are blocked. */
export function staffBlockedIds(blocks: readonly ActiveBlock[]): ReadonlySet<string> {
  return new Set(
    blocks.flatMap((block) =>
      block.section === BlockSection.Staff && block.institutionId !== null
        ? [block.institutionId]
        : [],
    ),
  );
}

/**
 * The section that stops a caller from every call but the allowed ones
 * (API design 6.5), given the Society's blocks and the active Institutions
 * their role reaches:
 *
 * - an Owner is stopped by an `owners` block of the Society, and by nothing
 *   else: staff and student blocks leave the Owner working;
 * - an Institution Admin, or a Teacher or Staff member, is stopped when every
 *   Institution they reach has its staff blocked (nothing is left for them to
 *   work in). With one still open they pass, and a call naming a blocked
 *   Institution gets 423 from the scope check;
 * - a parent is stopped per child, where a request names one, and not here.
 */
export function stoppingSection(
  roleCode: number | null,
  blocks: readonly ActiveBlock[],
  reachableInstitutionIds: readonly string[],
): BlockSection | null {
  switch (roleCode) {
    case RoleCode.SocietyOwner:
      return blocks.some((block) => block.section === BlockSection.Owners)
        ? BlockSection.Owners
        : null;
    default: {
      if (!isStaffRole(roleCode)) return null;
      const blocked = staffBlockedIds(blocks);
      return reachableInstitutionIds.length > 0 &&
        reachableInstitutionIds.every((id) => blocked.has(id))
        ? BlockSection.Staff
        : null;
    }
  }
}
