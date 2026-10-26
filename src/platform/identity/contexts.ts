import type { Grant } from './session.repository.js';

/** One role the person can act in (API design 6.3). Names and children arrive with the Tenancy and People modules. */
export interface Context {
  roleCode: number;
  societyId: string | null;
}

/**
 * The contexts a mobile session can choose from: one per role and Society
 * (an Institution Admin of two Institutions in one Society has one context).
 * A Super Admin acts on the console only (API design 10.4: roles 2 to 5 have
 * a mobile context), so the role 1 grant is not one of them.
 */
export function mobileContexts(grants: readonly Grant[]): Context[] {
  const seen = new Set<string>();
  const contexts: Context[] = [];
  for (const grant of grants) {
    if (grant.roleCode === 1) continue;
    const key = `${String(grant.roleCode)}:${grant.societyId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contexts.push({ roleCode: grant.roleCode, societyId: grant.societyId });
  }
  return contexts;
}

/** The one context a session starts in; with none or several the person chooses (AUTH-06). */
export function onlyContext(contexts: readonly Context[]): Context | null {
  return contexts.length === 1 ? (contexts[0] ?? null) : null;
}

/**
 * Whether the person may act as `roleCode` in `societyId` (roles 2 and 3 by
 * a grant). Roles 4 and 5 come from staff and guardian records, which exist
 * from the People module on; until then they are never available.
 */
export function canActAs(
  contexts: readonly Context[],
  roleCode: number,
  societyId: string | null,
): boolean {
  return contexts.some(
    (context) => context.roleCode === roleCode && context.societyId === societyId,
  );
}
