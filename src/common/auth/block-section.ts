import { RoleCode } from './roles.js';

/**
 * The sections of people Super Admin can block (owner decision, 26 Oct 2026;
 * API design 6.5). A block stops one section and nobody else.
 */
export const BlockSection = {
  /** A Society's Owners. */
  Owners: 1,
  /** One Institution's Institution Admins and Teachers and Staff. */
  Staff: 2,
  /** Parents' access to one Institution's students. */
  Students: 3,
} as const;

export type BlockSection = (typeof BlockSection)[keyof typeof BlockSection];

/** The section as the API names it. */
export const BlockSectionName: Record<BlockSection, 'owners' | 'staff' | 'students'> = {
  [BlockSection.Owners]: 'owners',
  [BlockSection.Staff]: 'staff',
  [BlockSection.Students]: 'students',
};

/** The roles a block of the section stops. Super Admin is never blocked this way. */
export const SECTION_ROLES: Record<BlockSection, readonly RoleCode[]> = {
  [BlockSection.Owners]: [RoleCode.SocietyOwner],
  [BlockSection.Staff]: [RoleCode.InstitutionAdmin, RoleCode.TeacherStaff],
  [BlockSection.Students]: [RoleCode.StudentParent],
};
