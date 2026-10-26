import { addressColumns, contactColumns } from './profile-columns.js';

describe('contactColumns', () => {
  it('leaves out what is omitted, lower-cases the email and splits the phone', () => {
    expect(contactColumns({})).toEqual({});
    expect(
      contactColumns({
        email: 'Office@Sun.ORG',
        phone: { countryCode: '91', number: '9876543210' },
      }),
    ).toEqual({ email: 'office@sun.org', country_code: '91', phone_number: '9876543210' });
  });

  it('clears with null, both parts of the phone together', () => {
    expect(contactColumns({ email: null, phone: null })).toEqual({
      email: null,
      country_code: null,
      phone_number: null,
    });
  });
});

describe('addressColumns', () => {
  it('replaces the address whole: a missing part becomes null', () => {
    expect(addressColumns({ line1: 'A' })).toEqual({
      address_line_1: 'A',
      address_line_2: null,
      pincode: null,
    });
    expect(addressColumns({ line2: 'B', pincode: '1' })).toEqual({
      address_line_1: null,
      address_line_2: 'B',
      pincode: '1',
    });
    expect(addressColumns(null)).toEqual({
      address_line_1: null,
      address_line_2: null,
      pincode: null,
    });
  });
});
