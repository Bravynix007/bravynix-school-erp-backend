import type { ProtectedAadhaar } from '../../platform/identity-numbers/index.js';

/** True when a request leaves the stored number as it is: the same hash, or no number on either side. */
export function sameNumber(
  stored: { aadhaar_hmac: Buffer | null } | undefined,
  claim: ProtectedAadhaar | null,
): boolean {
  const had = stored?.aadhaar_hmac ?? null;
  return had === null || claim === null ? had === claim : had.equals(claim.hmac);
}
