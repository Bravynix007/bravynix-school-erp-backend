import { identityResource, maskedAadhaar } from './identity.resource.js';
import type { IdentityRow } from './identity.repository.js';

describe('identity resource', () => {
  it('masks all but the last four digits', () => {
    expect(maskedAadhaar({ aadhaar_last4: '0124' })).toBe('XXXX XXXX 0124');
  });

  it.each([[undefined], [{ aadhaar_last4: null }]])(
    'is null when no number is held (%#)',
    (row) => {
      expect(maskedAadhaar(row)).toBeNull();
      expect(identityResource(row as IdentityRow | undefined)).toEqual({ aadhaarMasked: null });
    },
  );

  it('shows nothing but the masked number', () => {
    const row = { aadhaar_last4: '0124', aadhaar_ciphertext: Buffer.from('x') } as IdentityRow;
    expect(identityResource(row)).toEqual({ aadhaarMasked: 'XXXX XXXX 0124' });
  });
});
