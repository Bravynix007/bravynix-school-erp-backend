import { RoleCode } from '../../common/auth/roles.js';
import type { Grant } from './session.repository.js';

/** The role a session acts in (API design 6.3). */
export interface Context {
  roleCode: number;
  societyId: string | null;
}

/**
 * One role the person can choose from the list in AUTH-02 and ME-01 (API
 * design 6.3). Staff and children arrive with the People module. `isBlocked`
 * says a section block stops the role there (PLT-42): the Owners of the Society
 * are blocked, or every Institution the person reaches has its staff blocked.
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
      grant.roleCode === RoleCode.SocietyOwner ? grant.ownersBlocked : grant.staffBlocked;
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

/** The one context a session starts in; with none or several the person chooses (AUTH-06). */
export function onlyContext<T extends Context>(contexts: readonly T[]): T | null {
  return contexts.length === 1 ? (contexts[0] ?? null) : null;
}

/**
 * The listed context for `roleCode` in `societyId`, which is what the person
 * may act as (roles 2 and 3 by a grant). Roles 4 and 5 come from staff and
 * guardian records, which exist from the People module on; until then they
 * are never listed.
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
