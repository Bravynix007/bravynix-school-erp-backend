import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateStaffDto, UpdateStaffDto } from './staff.dto.js';

const id = '0192f3b0-0000-7000-8000-000000000001';
const valid = {
  homeInstitutionId: id,
  email: 'meera@example.com',
  firstName: 'Meera',
  classCategoryId: id,
  mobile: { countryCode: '91', number: '9876500001' },
};
const contact = { contactName: 'Ravi', phone: { countryCode: '91', number: '9876500003' } };

const many = (n: number, item: object) => Array.from({ length: n }, () => item);

describe('CreateStaffDto', () => {
  it('takes the required fields alone, or with every optional one', async () => {
    expect(await problems(body(CreateStaffDto, valid))).toEqual([]);
    expect(
      await problems(
        body(CreateStaffDto, {
          ...valid,
          lastName: 'Iyer',
          employeeCode: 'EMP-1',
          gender: 2,
          dateOfBirth: '1990-04-12',
          bloodGroup: 'AB-',
          nationality: 'Indian',
          photoFileId: id,
          designationId: id,
          alternateNumber: '9876500002',
          address: {
            line1: '4 Temple Street',
            countryId: id,
            stateId: id,
            cityId: id,
            pincode: '1',
          },
          joiningDate: '2024-06-03',
          resignationDate: null,
          employmentType: 4,
          educations: [{ degree: 'B.Ed', yearOfPassing: 2014 }],
          emergencyContacts: [{ ...contact, isPrimary: true }],
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{ homeInstitutionId: undefined }, 'homeInstitutionId'],
    [{ email: undefined }, 'email'],
    [{ firstName: undefined }, 'firstName'],
    [{ classCategoryId: undefined }, 'classCategoryId'],
    [{ mobile: undefined }, 'mobile'],
  ])('needs %j', async (change, field) => {
    expect(
      (await problems(body(CreateStaffDto, { ...valid, ...change }))).map((p) => p.field),
    ).toContain(field);
  });

  it.each([
    [{ email: 'not-an-email' }, 'email', 'INVALID_FORMAT'],
    [{ firstName: '' }, 'firstName', 'TOO_SHORT'],
    [{ firstName: 'x'.repeat(101) }, 'firstName', 'TOO_LONG'],
    [{ gender: 4 }, 'gender', 'INVALID_CODE'],
    [{ gender: '2' }, 'gender', 'INVALID_TYPE'],
    [{ bloodGroup: 'C+' }, 'bloodGroup', 'INVALID_CODE'],
    [{ dateOfBirth: '1990-02-30' }, 'dateOfBirth', 'INVALID_FORMAT'],
    [{ alternateNumber: '12345' }, 'alternateNumber', 'INVALID_FORMAT'],
    [{ employmentType: 5 }, 'employmentType', 'INVALID_CODE'],
    [{ employeeCode: '' }, 'employeeCode', 'TOO_SHORT'],
    [{ photoFileId: 'x' }, 'photoFileId', 'INVALID_FORMAT'],
    [{ address: { pincode: 'x'.repeat(11) } }, 'address.pincode', 'TOO_LONG'],
    [{ educations: [{ degree: '' }] }, 'educations[0].degree', 'TOO_SHORT'],
    [
      { educations: [{ degree: 'B', yearOfPassing: 1800 }] },
      'educations[0].yearOfPassing',
      'OUT_OF_RANGE',
    ],
    [{ emergencyContacts: [{ ...contact }] }, 'emergencyContacts[0].isPrimary', 'INVALID_TYPE'],
    [{ status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
    [{ societyId: id }, 'societyId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (change, field, code) => {
    expect(await problems(body(CreateStaffDto, { ...valid, ...change }))).toContainEqual({
      field,
      code,
    });
  });

  it('limits the two lists', async () => {
    expect(
      await problems(body(CreateStaffDto, { ...valid, educations: many(21, { degree: 'B' }) })),
    ).toContainEqual({ field: 'educations', code: 'TOO_MANY' });
    expect(
      await problems(
        body(CreateStaffDto, {
          ...valid,
          emergencyContacts: many(11, { ...contact, isPrimary: false }),
        }),
      ),
    ).toContainEqual({ field: 'emergencyContacts', code: 'TOO_MANY' });
  });
});

describe('UpdateStaffDto', () => {
  it('needs the version, and takes any field or none', async () => {
    expect(await problems(body(UpdateStaffDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateStaffDto, {
          version: 2,
          firstName: 'Meera',
          lastName: null,
          employeeCode: null,
          address: { line1: null, cityId: null },
          educations: [],
          emergencyContacts: [],
        }),
      ),
    ).toEqual([]);
    expect(await problems(body(UpdateStaffDto, { firstName: 'Meera' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });

  it.each([
    [{ firstName: null }, 'firstName'],
    [{ classCategoryId: null }, 'classCategoryId'],
    [{ mobile: null }, 'mobile'],
  ])('does not let %j be cleared', async (change, field) => {
    expect(
      (await problems(body(UpdateStaffDto, { version: 1, ...change }))).map((p) => p.field),
    ).toContain(field);
  });

  it.each([
    [{ email: 'a@b.co' }, 'email'],
    [{ homeInstitutionId: id }, 'homeInstitutionId'],
  ])('does not take %j here', async (change, field) => {
    expect(await problems(body(UpdateStaffDto, { version: 1, ...change }))).toContainEqual({
      field,
      code: 'FIELD_NOT_ALLOWED',
    });
  });
});
