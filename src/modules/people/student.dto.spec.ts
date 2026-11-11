import { body, problems } from '../../../test/support/dto-validation.js';
import {
  CreateStudentDto,
  DeactivateStudentDto,
  ListStudentsQueryDto,
  MoveStudentDto,
  UpdateStudentDto,
} from './student.dto.js';

const id = '0192f3b0-0000-7000-8000-000000000001';
const guardian = {
  firstName: 'Ravi',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  isPrimary: true,
  isEmergencyContact: false,
};
const valid = {
  institutionId: id,
  firstName: 'Diya',
  mobile: { countryCode: '91', number: '9876501234' },
  enrolment: { academicYearId: id, classId: id, sectionId: id, rollNumber: '14' },
  guardians: [guardian],
};

const many = (n: number, item: object) => Array.from({ length: n }, () => item);

describe('CreateStudentDto', () => {
  it('takes the required fields alone, or with every optional one', async () => {
    expect(await problems(body(CreateStudentDto, valid))).toEqual([]);
    expect(
      await problems(
        body(CreateStudentDto, {
          ...valid,
          lastName: 'Shetty',
          gender: 2,
          dateOfBirth: '2014-03-09',
          bloodGroup: 'O+',
          nationality: 'Indian',
          photoFileId: id,
          admissionNo: 'GVS-2026-0412',
          admissionDate: '2026-06-01',
          contactEmail: 'diya@example.com',
          alternateNumber: '9876501235',
          address: {
            line1: '4 Temple Street',
            countryId: id,
            stateId: id,
            cityId: id,
            pincode: '1',
          },
          guardians: [
            {
              ...guardian,
              lastName: 'Shetty',
              alternatePhone: '9845012346',
              email: 'ravi@example.com',
              occupation: 'Engineer',
            },
            { ...guardian, relation: 6, isPrimary: false, email: null, lastName: null },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{ institutionId: undefined }, 'institutionId'],
    [{ firstName: undefined }, 'firstName'],
    [{ mobile: undefined }, 'mobile'],
    [{ enrolment: undefined }, 'enrolment'],
    [{ guardians: undefined }, 'guardians'],
  ])('needs %j', async (change, field) => {
    expect(
      (await problems(body(CreateStudentDto, { ...valid, ...change }))).map((p) => p.field),
    ).toContain(field);
  });

  it.each([
    [{ firstName: '' }, 'firstName', 'TOO_SHORT'],
    [{ firstName: '   ' }, 'firstName', 'INVALID_FORMAT'],
    [{ firstName: 'x'.repeat(101) }, 'firstName', 'TOO_LONG'],
    [{ gender: 4 }, 'gender', 'INVALID_CODE'],
    [{ gender: '2' }, 'gender', 'INVALID_TYPE'],
    [{ bloodGroup: 'C+' }, 'bloodGroup', 'INVALID_CODE'],
    [{ dateOfBirth: '2014-02-30' }, 'dateOfBirth', 'INVALID_FORMAT'],
    [{ admissionDate: '1-6-2026' }, 'admissionDate', 'INVALID_FORMAT'],
    [{ admissionNo: '' }, 'admissionNo', 'TOO_SHORT'],
    [{ admissionNo: '  ' }, 'admissionNo', 'INVALID_FORMAT'],
    [{ admissionNo: 'x'.repeat(51) }, 'admissionNo', 'TOO_LONG'],
    [{ contactEmail: 'not-an-email' }, 'contactEmail', 'INVALID_FORMAT'],
    [{ alternateNumber: '12345' }, 'alternateNumber', 'INVALID_FORMAT'],
    [{ photoFileId: 'x' }, 'photoFileId', 'INVALID_FORMAT'],
    [{ address: { pincode: 'x'.repeat(11) } }, 'address.pincode', 'TOO_LONG'],
    [{ mobile: { countryCode: '91', number: '123' } }, 'mobile.number', 'INVALID_FORMAT'],
    [{ enrolment: { ...valid.enrolment, rollNumber: '' } }, 'enrolment.rollNumber', 'TOO_SHORT'],
    [
      { enrolment: { ...valid.enrolment, rollNumber: ' ' } },
      'enrolment.rollNumber',
      'INVALID_FORMAT',
    ],
    [
      { enrolment: { ...valid.enrolment, rollNumber: 'x'.repeat(21) } },
      'enrolment.rollNumber',
      'TOO_LONG',
    ],
    [{ enrolment: { ...valid.enrolment, rollNumber: 14 } }, 'enrolment.rollNumber', 'INVALID_TYPE'],
    [
      { enrolment: { ...valid.enrolment, sectionId: 'x' } },
      'enrolment.sectionId',
      'INVALID_FORMAT',
    ],
    [{ guardians: [] }, 'guardians', 'TOO_FEW'],
    [{ guardians: many(6, guardian) }, 'guardians', 'TOO_MANY'],
    [{ guardians: [{ ...guardian, firstName: ' ' }] }, 'guardians[0].firstName', 'INVALID_FORMAT'],
    [{ guardians: [{ ...guardian, relation: 7 }] }, 'guardians[0].relation', 'INVALID_CODE'],
    [{ guardians: [{ ...guardian, phone: undefined }] }, 'guardians[0].phone', 'INVALID_TYPE'],
    [{ guardians: [{ ...guardian, email: 'x' }] }, 'guardians[0].email', 'INVALID_FORMAT'],
    [
      { guardians: [{ ...guardian, alternatePhone: '1' }] },
      'guardians[0].alternatePhone',
      'INVALID_FORMAT',
    ],
    [
      { guardians: [{ ...guardian, isPrimary: undefined }] },
      'guardians[0].isPrimary',
      'INVALID_TYPE',
    ],
    [
      { guardians: [{ ...guardian, isEmergencyContact: 'yes' }] },
      'guardians[0].isEmergencyContact',
      'INVALID_TYPE',
    ],
    // Not built yet: refused, never quietly dropped.
    [{ identity: { aadhaarNumber: '234567890124' } }, 'identity', 'FIELD_NOT_ALLOWED'],
    [{ fromEnquiryId: id }, 'fromEnquiryId', 'FIELD_NOT_ALLOWED'],
    [{ status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
    [{ societyId: id }, 'societyId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (change, field, code) => {
    expect(await problems(body(CreateStudentDto, { ...valid, ...change }))).toContainEqual({
      field,
      code,
    });
  });
});

describe('UpdateStudentDto', () => {
  it('needs the version, and takes any field or none', async () => {
    expect(await problems(body(UpdateStudentDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateStudentDto, {
          version: 2,
          firstName: 'Diya',
          lastName: null,
          gender: null,
          dateOfBirth: null,
          bloodGroup: null,
          nationality: null,
          photoFileId: null,
          admissionNo: null,
          admissionDate: null,
          contactEmail: null,
          mobile: { countryCode: '91', number: '9876501234' },
          alternateNumber: null,
          address: { line1: null, cityId: null },
        }),
      ),
    ).toEqual([]);
    expect(await problems(body(UpdateStudentDto, { firstName: 'Diya' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });

  it.each([
    [{ firstName: null }, 'firstName'],
    [{ mobile: null }, 'mobile'],
  ])('does not let %j be cleared', async (change, field) => {
    expect(
      (await problems(body(UpdateStudentDto, { version: 1, ...change }))).map((p) => p.field),
    ).toContain(field);
  });

  it('refuses a name or an Admission ID of only spaces', async () => {
    expect(
      await problems(body(UpdateStudentDto, { version: 1, firstName: '   ', admissionNo: '  ' })),
    ).toEqual([
      { field: 'firstName', code: 'INVALID_FORMAT' },
      { field: 'admissionNo', code: 'INVALID_FORMAT' },
    ]);
  });

  it.each([
    [{ institutionId: id }, 'institutionId'],
    [{ enrolment: valid.enrolment }, 'enrolment'],
    [{ guardians: [guardian] }, 'guardians'],
    [{ status: 0 }, 'status'],
  ])('does not take %j here', async (change, field) => {
    expect(await problems(body(UpdateStudentDto, { version: 1, ...change }))).toContainEqual({
      field,
      code: 'FIELD_NOT_ALLOWED',
    });
  });
});

describe('DeactivateStudentDto', () => {
  it.each([1, 2, 3])('takes reason %i', async (reason) => {
    expect(await problems(body(DeactivateStudentDto, { reason }))).toEqual([]);
  });

  it.each([
    [{}, 'INVALID_TYPE'],
    [{ reason: 0 }, 'INVALID_CODE'],
    [{ reason: 4 }, 'INVALID_CODE'],
    [{ reason: '1' }, 'INVALID_TYPE'],
  ])('refuses %j', async (value, code) => {
    expect(await problems(body(DeactivateStudentDto, value))).toEqual([{ field: 'reason', code }]);
  });
});

describe('MoveStudentDto', () => {
  it('takes the section, the roll number and the day, together or alone, or none', async () => {
    expect(await problems(body(MoveStudentDto, {}))).toEqual([]);
    expect(await problems(body(MoveStudentDto, { sectionId: id }))).toEqual([]);
    expect(await problems(body(MoveStudentDto, { rollNumber: '15' }))).toEqual([]);
    expect(
      await problems(
        body(MoveStudentDto, { sectionId: id, rollNumber: '15', effectiveDate: '2026-07-01' }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{ sectionId: null }, 'sectionId', 'INVALID_FORMAT'],
    [{ sectionId: 'x' }, 'sectionId', 'INVALID_FORMAT'],
    [{ rollNumber: null }, 'rollNumber', 'INVALID_TYPE'],
    [{ rollNumber: '' }, 'rollNumber', 'TOO_SHORT'],
    [{ rollNumber: '   ' }, 'rollNumber', 'INVALID_FORMAT'],
    [{ rollNumber: 'x'.repeat(21) }, 'rollNumber', 'TOO_LONG'],
    [{ effectiveDate: null }, 'effectiveDate', 'INVALID_TYPE'],
    [{ effectiveDate: '2026-02-30' }, 'effectiveDate', 'INVALID_FORMAT'],
    [{ classId: id }, 'classId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(MoveStudentDto, value))).toContainEqual({ field, code });
  });
});

const query = (value: object) => problems(body(ListStudentsQueryDto, value));

describe('ListStudentsQueryDto', () => {
  it('takes no filter, or every filter', async () => {
    expect(await query({})).toEqual([]);
    expect(
      await query({
        page: '2',
        limit: '50',
        sort: '-rollNumber',
        q: 'di',
        institutionId: id,
        academicYearId: id,
        classId: id,
        sectionId: id,
        status: ['0', '1'],
      }),
    ).toEqual([]);
  });

  it('converts status to numbers, one value or several, and refuses any but 0 and 1', async () => {
    expect((await body(ListStudentsQueryDto, { status: '0' })).status).toEqual([0]);
    expect((await body(ListStudentsQueryDto, { status: ['1', '0'] })).status).toEqual([1, 0]);
    expect(await query({ status: '2' })).toContainEqual({ field: 'status', code: 'INVALID_CODE' });
    expect(await query({ status: 'x' })).toContainEqual({ field: 'status', code: 'INVALID_CODE' });
  });

  it.each([
    [{ institutionId: 'x' }, 'institutionId'],
    [{ academicYearId: 'x' }, 'academicYearId'],
    [{ classId: 'x' }, 'classId'],
    [{ sectionId: 'x' }, 'sectionId'],
    [{ q: 'x' }, 'q'],
  ])('refuses %j', async (change, field) => {
    expect((await query(change)).map((p) => p.field)).toContain(field);
  });
});
