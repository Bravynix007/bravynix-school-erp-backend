import { body, problems } from '../../../test/support/dto-validation.js';
import { StudentIdentityDto } from './student-identity.dto.js';

describe('StudentIdentityDto', () => {
  it.each([
    ['both numbers', { aadhaarNumber: '2345 6789 0124', birthCertificateNumber: 'BC/2014/0042' }],
    ['the Aadhaar number alone, hyphens included', { aadhaarNumber: '2345-6789-0124' }],
    ['the certificate alone', { birthCertificateNumber: 'BC-1' }],
    ['nothing', {}],
    ['null on both: they clear', { aadhaarNumber: null, birthCertificateNumber: null }],
  ])('takes %s', async (_name, value) => {
    expect(await problems(body(StudentIdentityDto, value))).toEqual([]);
  });

  it('is not an Aadhaar check: a number that is wrong is the service’s 422', async () => {
    expect(await problems(body(StudentIdentityDto, { aadhaarNumber: '12' }))).toEqual([]);
  });

  it('takes a certificate number of 50 characters and not 51', async () => {
    expect(
      await problems(body(StudentIdentityDto, { birthCertificateNumber: 'B'.repeat(50) })),
    ).toEqual([]);
    expect(
      await problems(body(StudentIdentityDto, { birthCertificateNumber: 'B'.repeat(51) })),
    ).toEqual([{ field: 'birthCertificateNumber', code: 'TOO_LONG' }]);
  });

  it.each([
    [
      'an Aadhaar number as a JSON number',
      { aadhaarNumber: 234567890124 },
      'aadhaarNumber',
      'INVALID_TYPE',
    ],
    ['text longer than 30', { aadhaarNumber: '2'.repeat(31) }, 'aadhaarNumber', 'TOO_LONG'],
    [
      'an empty certificate number',
      { birthCertificateNumber: '' },
      'birthCertificateNumber',
      'TOO_SHORT',
    ],
    [
      'a certificate number of only spaces',
      { birthCertificateNumber: '  ' },
      'birthCertificateNumber',
      'INVALID_FORMAT',
    ],
    [
      'a certificate number as a JSON number',
      { birthCertificateNumber: 5 },
      'birthCertificateNumber',
      'INVALID_TYPE',
    ],
    ['a bank field: they are not built', { bankAccount: '1' }, 'bankAccount', 'FIELD_NOT_ALLOWED'],
  ])('refuses %s', async (_name, value, field, code) => {
    expect(await problems(body(StudentIdentityDto, value))).toContainEqual({ field, code });
  });
});
