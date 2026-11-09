import { RoleCode } from '../../common/auth/roles.js';
import type { Grant } from './session.repository.js';

/** The role a session acts in (API design 6.3). */
export interface Context {
  roleCode: number;
  societyId: string | null;
}

/**
 * One role the person can choose from the list in AUTH-02 and ME-01 (API
 * design 6.3). Children arrive with the guardians. `isBlocked`
 * says a block stops the role there: a section block (PLT-42) when the Owners of the Society are blocked or every
 * Institution the person reaches has its staff blocked, or, for the staff roles, the person's own staff record in the
 * Society is blocked (STF-06).
 */
export interface ContextChoice extends Context {
  societyName: string | null;
  isBlocked: boolean;
}

/** The console's one context: Super Admin, no Society. */
export const CONSOLE_CONTEXT: ContextChoice = {
  roleCode: 1,
  societyId: null,
  societyName: null,
  isBlocked: false,
};

/**
 * The contexts a mobile session can choose from: one per role and Society
 * (an Institution Admin of two Institutions in one Society has one context).
 * A Super Admin acts on the console only (API design 10.4: roles 2 to 5 have
 * a mobile context), so the role 1 grant is not one of them.
 */
export function mobileContexts(grants: readonly Grant[]): ContextChoice[] {
  const contexts = new Map<string, ContextChoice>();
  for (const grant of grants) {
    if (grant.roleCode === 1) continue;
    const key = `${String(grant.roleCode)}:${grant.societyId ?? ''}`;
    const blocked =
      grant.roleCode === RoleCode.SocietyOwner
        ? grant.ownersBlocked
        : grant.staffBlocked || grant.accessBlocked;
    const listed = contexts.get(key);
    if (listed) {
      // One context for several Institutions: blocked only when none is left open.
      listed.isBlocked &&= blocked;
    } else {
      contexts.set(key, {
        roleCode: grant.roleCode,
        societyId: grant.societyId,
        societyName: grant.societyName,
        isBlocked: blocked,
      });
    }
  }
  return [...contexts.values()];
}

/**
 * Is the person's own staff record blocked in the context they chose (STF-06)? It is a property of the person in the
 * Society, so one entry of the role there is enough.
 */
export function accessBlockedIn(
  grants: readonly Grant[],
  roleCode: number,
  societyId: string | null,
): boolean {
  return grants.some(
    (grant) => grant.roleCode === roleCode && grant.societyId === societyId && grant.accessBlocked,
  );
}

/** The one context a session starts in; with none or several the person chooses (AUTH-06). */
export function onlyContext<T extends Context>(contexts: readonly T[]): T | null {
  return contexts.length === 1 ? (contexts[0] ?? null) : null;
}

/**
 * The listed context for `roleCode` in `societyId`, which is what the person
 * may act as (roles 2 and 3 by a grant, role 4 by an active staff record).
 * Role 5 comes from a guardian link, which exists from a later slice on;
 * until then it is never listed.
 */
export function findContext<T extends Context>(
  contexts: readonly T[],
  roleCode: number,
  societyId: string | null,
): T | undefined {
  return contexts.find(
    (context) => context.roleCode === roleCode && context.societyId === societyId,
  );
}
