/**
 * Role codes, fixed by PRD 11.4 and API design 6.3. The apps already route by
 * these numbers; never renumber them.
 */
export const RoleCode = {
  SuperAdmin: 1,
  SocietyOwner: 2,
  InstitutionAdmin: 3,
  TeacherStaff: 4,
  StudentParent: 5,
} as const;

export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];

/** Short names used in the API catalogue's Roles column. */
export const RoleShortName: Record<RoleCode, 'SA' | 'SO' | 'IA' | 'TS' | 'SP'> = {
  1: 'SA',
  2: 'SO',
  3: 'IA',
  4: 'TS',
  5: 'SP',
};

export const ALL_ROLES: readonly RoleCode[] = [1, 2, 3, 4, 5];

/** Names for the author stamps (API design 7.6). Roles 4 and 5 are named by the People module. */
export const RoleName: Record<RoleCode, string> = {
  1: 'Super Admin',
  2: 'Society Owner',
  3: 'Institution Admin',
  4: 'Teacher',
  5: 'Parent',
};
