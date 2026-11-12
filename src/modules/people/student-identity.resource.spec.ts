import type { StudentIdentityRow } from './student-identity.repository.js';
import { studentIdentityResource } from './student-identity.resource.js';

describe('studentIdentityResource', () => {
  it('masks the Aadhaar number by its last four digits and shows the certificate as typed', () => {
    const row = {
      aadhaar_last4: '0124',
      aadhaar_ciphertext: Buffer.from('sealed'),
      aadhaar_hmac: Buffer.alloc(32, 1),
      birth_certificate_number: 'BC/2014/0042',
    } as StudentIdentityRow;
    const resource = studentIdentityResource(row);
    expect(resource).toEqual({
      aadhaarMasked: 'XXXX XXXX 0124',
      birthCertificateNumber: 'BC/2014/0042',
    });
    expect(Object.keys(resource)).toEqual(['aadhaarMasked', 'birthCertificateNumber']);
  });

  it.each([
    ['no row', undefined],
    [
      'a row whose numbers were cleared',
      { aadhaar_last4: null, birth_certificate_number: null } as StudentIdentityRow,
    ],
  ])('shows null for each number for %s', (_name, row) => {
    expect(studentIdentityResource(row)).toEqual({
      aadhaarMasked: null,
      birthCertificateNumber: null,
    });
  });
});
