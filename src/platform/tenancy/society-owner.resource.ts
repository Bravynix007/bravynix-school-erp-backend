import type { GrantedPerson, OwnerGrant } from '../identity/index.js';

/** A Society Owner as PLT-09 answers it. */
export interface SocietyOwnerResource {
  id: string;
  email: string;
  displayName: string;
  societyId: string;
  seatNo: number;
}

/** One row of PLT-11: the Owner and the Society they own. */
export interface SocietyOwnerSummary {
  id: string;
  email: string;
  displayName: string;
  accountStatus: number;
  blockedAt: string | null;
  blockReason: string | null;
  version: number;
  seatNo: number;
  grantedAt: string;
  society: { id: string; code: string; name: string };
}

export function ownerResource(person: GrantedPerson, societyId: string): SocietyOwnerResource {
  return {
    id: person.id,
    email: person.email,
    displayName: person.displayName,
    societyId,
    seatNo: person.seatNo,
  };
}

export function ownerSummary(
  grant: OwnerGrant,
  societies: ReadonlyMap<string, { id: string; code: string; name: string }>,
): SocietyOwnerSummary {
  return {
    id: grant.id,
    email: grant.email,
    displayName: grant.displayName,
    accountStatus: grant.accountStatus,
    blockedAt: grant.blockedAt?.toISOString() ?? null,
    blockReason: grant.blockReason,
    version: grant.version,
    seatNo: grant.seatNo,
    grantedAt: grant.grantedAt.toISOString(),
    society: societies.get(grant.societyId)!,
  };
}
