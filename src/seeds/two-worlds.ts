import type { RoleCode } from '../common/auth/roles.js';

/**
 * The "two worlds" seed from the QA strategy (section 4): every isolation test
 * has a sibling tenant to leak into. IDs and emails are fixed so tests and QA
 * scripts can refer to them by name. All emails use the reserved `.test`
 * domain, so nothing can ever be delivered.
 *
 * This file is the single list of personas. The Identity and Tenancy modules
 * (phase 1) add the code that writes them; later modules add their own rows
 * (classes, students, fees) to the same worlds.
 */

export interface SeedSociety {
  key: 'A' | 'B';
  id: string;
  name: string;
  isPaused: boolean;
}

export interface SeedInstitution {
  key: 'A1' | 'A2' | 'B1';
  id: string;
  society: SeedSociety['key'];
  name: string;
  code: string;
  isPaused: boolean;
}

export type AccountStatus = 'pending' | 'active' | 'blocked' | 'inactive';

export interface SeedGrant {
  role: RoleCode;
  society?: SeedSociety['key'];
  /** For role 3: the Institutions administered. For role 4: home first, then extra. */
  institutions?: SeedInstitution['key'][];
  /** For role 4: what the teacher is assigned to teach. */
  assignment?: string;
  /** For role 5: keys of the children linked to this guardian. */
  children?: string[];
}

export interface SeedPersona {
  key: string;
  id: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  grants: SeedGrant[];
  note?: string;
}

export interface SeedChild {
  key: string;
  id: string;
  institution: SeedInstitution['key'];
  displayName: string;
  classSection: string;
  isBlocked: boolean;
}

const id = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;
const email = (key: string): string => `${key.toLowerCase()}@two-worlds.test`;

export const societies: SeedSociety[] = [
  { key: 'A', id: id(1001), name: 'Society A', isPaused: false },
  { key: 'B', id: id(1002), name: 'Society B', isPaused: false },
];

export const institutions: SeedInstitution[] = [
  { key: 'A1', id: id(2001), society: 'A', name: 'Institution A1', code: 'A1', isPaused: false },
  { key: 'A2', id: id(2002), society: 'A', name: 'Institution A2', code: 'A2', isPaused: false },
  { key: 'B1', id: id(2003), society: 'B', name: 'Institution B1', code: 'B1', isPaused: false },
];

export const children: SeedChild[] = [
  {
    key: 'C-A1-one',
    id: id(4001),
    institution: 'A1',
    displayName: 'Child A1 One',
    classSection: '5-A',
    isBlocked: false,
  },
  {
    key: 'C-A1-sib1',
    id: id(4002),
    institution: 'A1',
    displayName: 'Child A1 Sibling 1',
    classSection: '5-A',
    isBlocked: false,
  },
  {
    key: 'C-A1-sib2',
    id: id(4003),
    institution: 'A1',
    displayName: 'Child A1 Sibling 2',
    classSection: '6-B',
    isBlocked: true,
  },
  {
    key: 'C-cross-A1',
    id: id(4004),
    institution: 'A1',
    displayName: 'Child Cross A1',
    classSection: '6-B',
    isBlocked: false,
  },
  {
    key: 'C-cross-B1',
    id: id(4005),
    institution: 'B1',
    displayName: 'Child Cross B1',
    classSection: '5-A',
    isBlocked: false,
  },
  {
    key: 'C-B1-one',
    id: id(4006),
    institution: 'B1',
    displayName: 'Child B1 One',
    classSection: '5-A',
    isBlocked: false,
  },
  {
    key: 'C-dual',
    id: id(4007),
    institution: 'A1',
    displayName: 'Child of Dual Role',
    classSection: '5-A',
    isBlocked: false,
  },
];

let next = 3001;
function persona(
  key: string,
  displayName: string,
  grants: SeedGrant[],
  status: AccountStatus = 'active',
  note?: string,
): SeedPersona {
  return { key, id: id(next++), email: email(key), displayName, status, grants, note };
}

export const personas: SeedPersona[] = [
  // Platform
  persona('SA1', 'Super Admin 1', [{ role: 1 }]),
  persona('SA2', 'Super Admin 2', [{ role: 1 }]),
  persona(
    'SA4-candidate',
    'Super Admin seat-limit candidate',
    [],
    'active',
    'Used to attempt a 4th Super Admin',
  ),
  // Society Owners
  persona('SO-A1', 'Owner A1', [{ role: 2, society: 'A' }]),
  persona('SO-A2', 'Owner A2', [{ role: 2, society: 'A' }]),
  persona(
    'SO-A3',
    'Owner A3',
    [{ role: 2, society: 'A' }],
    'active',
    'Third owner: Society A is at the seat limit',
  ),
  persona('SO-B1', 'Owner B1', [{ role: 2, society: 'B' }]),
  // Institution Admins
  persona('IA-A1', 'Admin of A1', [{ role: 3, society: 'A', institutions: ['A1'] }]),
  persona('IA-A12', 'Admin of A1 and A2, also teaches', [
    { role: 3, society: 'A', institutions: ['A1', 'A2'] },
    { role: 4, society: 'A', institutions: ['A1'], assignment: 'Class 7-A English' },
  ]),
  persona('IA-B1', 'Admin of B1', [{ role: 3, society: 'B', institutions: ['B1'] }]),
  // Teachers
  persona('T-A1-assigned', 'Teacher A1 assigned', [
    { role: 4, society: 'A', institutions: ['A1'], assignment: 'Class 5-A Maths' },
  ]),
  persona('T-A1-other', 'Teacher A1 other', [
    { role: 4, society: 'A', institutions: ['A1'], assignment: 'Class 6-B' },
  ]),
  persona('T-A1-extra', 'Teacher A1 with extra A2', [
    { role: 4, society: 'A', institutions: ['A1', 'A2'], assignment: 'Class 5-A Science' },
  ]),
  persona('T-B1', 'Teacher B1', [
    { role: 4, society: 'B', institutions: ['B1'], assignment: 'Class 5-A Maths' },
  ]),
  // Parents
  persona('P-A1-one', 'Parent of one child', [{ role: 5, children: ['C-A1-one'] }]),
  persona('P-A1-siblings', 'Parent of siblings, one blocked', [
    { role: 5, children: ['C-A1-sib1', 'C-A1-sib2'] },
  ]),
  persona('P-cross', 'Parent with children in A1 and B1', [
    { role: 5, children: ['C-cross-A1', 'C-cross-B1'] },
  ]),
  persona('P-B1', 'Parent in B1', [{ role: 5, children: ['C-B1-one'] }]),
  // Dual role
  persona('TP-A1-dual', 'Teacher in A1 who is also a parent in A1', [
    { role: 4, society: 'A', institutions: ['A1'], assignment: 'Class 6-B Hindi' },
    { role: 5, children: ['C-dual'] },
  ]),
  // Edge accounts
  persona(
    'EDGE-pending',
    'Pending, never logged in',
    [{ role: 4, society: 'A', institutions: ['A1'] }],
    'pending',
  ),
  persona(
    'EDGE-blocked',
    'Blocked account',
    [{ role: 4, society: 'A', institutions: ['A1'] }],
    'blocked',
  ),
  persona(
    'EDGE-inactive',
    'Inactive account',
    [{ role: 4, society: 'A', institutions: ['A1'] }],
    'inactive',
  ),
];

/** Variant used by pause tests: Society A paused, Institution A2 paused. */
export const pausedVariant = { pausedSocieties: ['A'], pausedInstitutions: ['A2'] } as const;

export function personaByKey(key: string): SeedPersona {
  const found = personas.find((p) => p.key === key);
  if (!found) throw new Error(`Unknown seed persona: ${key}`);
  return found;
}
