import { maskAadhaar } from '../../platform/identity-numbers/index.js';
import type { IdentityRow } from './identity.repository.js';

/** What STF-11 answers: the number as it is shown everywhere, masked. Never the number itself. */
export interface IdentityResource {
  aadhaarMasked: string | null;
}

/** What STF-12 answers (API design 10.9). */
export interface RevealResource {
  field: 'aadhaar';
  value: string;
  revealedAt: string;
}

/** `null` when no number is set, a row that has been cleared included. */
export const maskedAadhaar = (
  row: Pick<IdentityRow, 'aadhaar_last4'> | undefined,
): string | null => (row?.aadhaar_last4 ? maskAadhaar(row.aadhaar_last4) : null);

export const identityResource = (row: IdentityRow | undefined): IdentityResource => ({
  aadhaarMasked: maskedAadhaar(row),
});
