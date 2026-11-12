import type { StudentIdentityRow } from './student-identity.repository.js';
import { maskedAadhaar } from './identity.resource.js';

/**
 * A student's identity as every answer shows it (API design 10.6, 10.9): the Aadhaar number masked, never whole, and
 * the birth certificate number as typed, which ordinary screens show (DDD 15.6). `null` for a number that is not set.
 */
export interface StudentIdentityResource {
  aadhaarMasked: string | null;
  birthCertificateNumber: string | null;
}

export const studentIdentityResource = (
  row: StudentIdentityRow | undefined,
): StudentIdentityResource => ({
  aadhaarMasked: maskedAadhaar(row),
  birthCertificateNumber: row?.birth_certificate_number ?? null,
});
