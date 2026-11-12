import { body, problems } from '../../../test/support/dto-validation.js';
import { UpdateGuardianDto } from './guardian.dto.js';

const everything = {
  version: 2,
  firstName: 'Ravi',
  lastName: 'Shetty',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  alternatePhone: '9845012346',
  email: 'ravi@example.com',
  occupation: 'Engineer',
  isPrimary: true,
  isEmergencyContact: false,
};

describe('UpdateGuardianDto', () => {
  it('needs the version, and takes any field or none', async () => {
    expect(await problems(body(UpdateGuardianDto, { version: 1 }))).toEqual([]);
    expect(await problems(body(UpdateGuardianDto, everything))).toEqual([]);
    expect(await problems(body(UpdateGuardianDto, { relation: 2 }))).toEqual([
      { field: 'version', code: 'INVALID_TYPE' },
    ]);
  });

  it('clears an optional field with null', async () => {
    expect(
      await problems(
        body(UpdateGuardianDto, {
          version: 1,
          lastName: null,
          alternatePhone: null,
          email: null,
          occupation: null,
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a name of only spaces', { firstName: '   ' }, 'firstName', 'INVALID_FORMAT'],
    ['no name: it cannot be cleared', { firstName: null }, 'firstName', 'INVALID_TYPE'],
    ['a relation outside 1 to 6', { relation: 7 }, 'relation', 'INVALID_CODE'],
    ['a relation as text', { relation: '1' }, 'relation', 'INVALID_TYPE'],
    ['no relation: it cannot be cleared', { relation: null }, 'relation', 'INVALID_TYPE'],
    ['no phone: it cannot be cleared', { phone: null }, 'phone', 'INVALID_TYPE'],
    [
      'a phone number of 5 digits',
      { phone: { countryCode: '91', number: '98450' } },
      'phone.number',
      'INVALID_FORMAT',
    ],
    [
      'an alternate number of 5 digits',
      { alternatePhone: '98450' },
      'alternatePhone',
      'INVALID_FORMAT',
    ],
    ['an email that is not one', { email: 'ravi' }, 'email', 'INVALID_FORMAT'],
    ['isPrimary as text', { isPrimary: 'yes' }, 'isPrimary', 'INVALID_TYPE'],
    ['no isPrimary: it cannot be cleared', { isPrimary: null }, 'isPrimary', 'INVALID_TYPE'],
    [
      'isEmergencyContact as a number',
      { isEmergencyContact: 1 },
      'isEmergencyContact',
      'INVALID_TYPE',
    ],
    ['a field that is not the guardian’s', { userId: 'x' }, 'userId', 'FIELD_NOT_ALLOWED'],
    ['a student', { studentId: 'x' }, 'studentId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %s', async (_name, change, field, code) => {
    expect(await problems(body(UpdateGuardianDto, { version: 1, ...change }))).toContainEqual({
      field,
      code,
    });
  });
});
