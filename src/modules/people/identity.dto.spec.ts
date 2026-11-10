import { body, problems } from '../../../test/support/dto-validation.js';
import { RevealIdentityDto, SetIdentityDto } from './identity.dto.js';

describe('SetIdentityDto', () => {
  it('takes the number as text, spaces and hyphens included, or null to clear', async () => {
    expect(await problems(body(SetIdentityDto, { aadhaar: '2345 6789 0124' }))).toEqual([]);
    expect(await problems(body(SetIdentityDto, { aadhaar: '2345-6789-0124' }))).toEqual([]);
    expect(await problems(body(SetIdentityDto, { aadhaar: null }))).toEqual([]);
  });

  it('is not an Aadhaar check: a number that is wrong is the service’s 422', async () => {
    expect(await problems(body(SetIdentityDto, { aadhaar: '12' }))).toEqual([]);
  });

  it.each([
    ['no number: null is the way to clear it', {}, [{ field: 'aadhaar', code: 'INVALID_TYPE' }]],
    [
      'a number as a JSON number',
      { aadhaar: 234567890124 },
      [{ field: 'aadhaar', code: 'INVALID_TYPE' }],
    ],
    ['text longer than 30', { aadhaar: '2'.repeat(31) }, [{ field: 'aadhaar', code: 'TOO_LONG' }]],
    [
      'a bank field: they are not built',
      { aadhaar: null, ifscCode: 'SBIN0001234' },
      [{ field: 'ifscCode', code: 'FIELD_NOT_ALLOWED' }],
    ],
  ])('refuses %s', async (_name, value, expected) => {
    expect(await problems(body(SetIdentityDto, value))).toEqual(expected);
  });
});

describe('RevealIdentityDto', () => {
  it('takes the field and a reason', async () => {
    expect(
      await problems(body(RevealIdentityDto, { field: 'aadhaar', reason: 'Payroll check' })),
    ).toEqual([]);
  });

  it.each([
    ['the bank account: not built', { field: 'bankAccount', reason: 'Payroll check' }, 'field'],
    ['no field', { reason: 'Payroll check' }, 'field'],
    ['no reason', { field: 'aadhaar' }, 'reason'],
    ['a reason as a number', { field: 'aadhaar', reason: 5 }, 'reason'],
  ])('refuses %s', async (_name, value, field) => {
    expect((await problems(body(RevealIdentityDto, value))).map((p) => p.field)).toEqual([field]);
  });
});
