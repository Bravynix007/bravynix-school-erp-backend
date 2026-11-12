import { AppException } from '../../common/http/app-exception.js';
import type { GuardianRow, PlacedRow, StudentRow } from './student.repository.js';
import {
  enrolmentAuditView,
  latestMoveDate,
  requireValidDates,
  requireValidMoveDate,
  requireValidStudent,
  studentAuditView,
} from './student.rules.js';

const primary = { isPrimary: true, email: null };
const other = { isPrimary: false, email: null };

const refusal = (input: Parameters<typeof requireValidStudent>[0]) => {
  try {
    requireValidStudent(input, '2026-11-11');
  } catch (error) {
    if (error instanceof AppException) {
      return {
        status: error.status as number,
        code: error.code,
        fields: (error.options.errors ?? []).map(({ field, code }) => ({ field, code })),
      };
    }
    throw error;
  }
  return null;
};

describe('requireValidStudent', () => {
  it('passes a student with no dates and one primary guardian', () => {
    expect(refusal({ guardians: [primary] })).toBeNull();
    expect(
      refusal({ dateOfBirth: null, admissionDate: null, guardians: [primary, other] }),
    ).toBeNull();
  });

  it('wants the date of birth from 1900 and before today', () => {
    expect(refusal({ dateOfBirth: '2026-11-10', guardians: [primary] })).toBeNull();
    expect(refusal({ dateOfBirth: '1900-01-01', guardians: [primary] })).toBeNull();
    for (const day of ['1899-12-31', '2026-11-11', '2027-01-01']) {
      expect(refusal({ dateOfBirth: day, guardians: [primary] })).toMatchObject({
        status: 400,
        fields: [{ field: 'dateOfBirth', code: 'INVALID_VALUE' }],
      });
    }
  });

  it('lets the admission fall on the date of birth but not before it, and only when both are known', () => {
    const input = { guardians: [primary] };
    expect(
      refusal({ ...input, dateOfBirth: '2014-03-09', admissionDate: '2014-03-09' }),
    ).toBeNull();
    expect(refusal({ ...input, admissionDate: '1990-01-01' })).toBeNull();
    expect(
      refusal({ ...input, dateOfBirth: '2014-03-09', admissionDate: '2014-03-08' }),
    ).toMatchObject({
      fields: [{ field: 'admissionDate', code: 'INVALID_VALUE' }],
    });
  });

  it('names every date that breaks a rule, in the order of the form', () => {
    expect(
      refusal({ dateOfBirth: '2027-01-01', admissionDate: '2000-01-01', guardians: [primary] })
        ?.fields,
    ).toEqual([
      { field: 'dateOfBirth', code: 'INVALID_VALUE' },
      { field: 'admissionDate', code: 'INVALID_VALUE' },
    ]);
  });

  it('refuses a second guardian with the same email, in any letter case, on that guardian', () => {
    const guardians = [
      { isPrimary: true, email: 'ravi@example.com' },
      { isPrimary: false, email: 'lata@example.com' },
      { isPrimary: false, email: 'RAVI@example.com' },
      { isPrimary: false, email: null },
      { isPrimary: false, email: null },
    ];
    expect(refusal({ guardians })).toMatchObject({
      status: 400,
      fields: [{ field: 'guardians[2].email', code: 'INVALID_VALUE' }],
    });
  });

  it.each([[[]], [[other]], [[primary, primary]], [[primary, other, primary]]])(
    'wants exactly one primary guardian: 422 PRIMARY_GUARDIAN_REQUIRED for %j',
    (guardians) => {
      expect(refusal({ guardians })).toMatchObject({
        status: 422,
        code: 'PRIMARY_GUARDIAN_REQUIRED',
      });
    },
  );

  it('answers the dates before the guardians', () => {
    expect(refusal({ dateOfBirth: '2027-01-01', guardians: [other] })?.status).toBe(400);
  });
});

const student = (overrides: Partial<StudentRow> = {}): StudentRow =>
  ({
    id: 'student-1',
    institution_id: 'institution-1',
    admission_no: 'GVS-1',
    first_name: 'Diya',
    last_name: 'Shetty',
    gender: 2,
    date_of_birth: '2014-03-09',
    blood_group: 'O+',
    nationality: 'Indian',
    photo_file_id: null,
    admission_date: '2026-06-01',
    contact_email: 'diya@example.com',
    country_code: '91',
    mobile_number: '9876501234',
    alternate_number: '9876501235',
    address_line_1: '4 Temple Street',
    address_line_2: null,
    country_id: 'country-1',
    state_id: null,
    city_id: null,
    pincode: '560001',
    status: 1,
    inactive_reason: null,
    ...overrides,
  }) as StudentRow;

const placed: PlacedRow = {
  placement_id: 'placement-1',
  enrolment_id: 'enrolment-1',
  academic_year_id: 'year-1',
  class_id: 'class-1',
  section_id: 'section-1',
  roll_number: '14',
  start_date: '2026-06-01',
  enrolled_date: '2026-06-01',
};

const guardian = (overrides: Partial<GuardianRow> = {}): GuardianRow =>
  ({
    id: 'guardian-1',
    user_id: 'user-1',
    first_name: 'Ravi',
    last_name: 'Shetty',
    relation: 1,
    country_code: '91',
    phone_number: '9845012345',
    alternate_phone: '9845012346',
    email: 'ravi@example.com',
    occupation: 'Engineer',
    is_primary: true,
    is_emergency_contact: false,
    ...overrides,
  }) as GuardianRow;

describe('studentAuditView', () => {
  it('keeps names, codes, dates and where the child sits, and the guardians by name and relation', () => {
    expect(studentAuditView(student(), placed, [guardian()])).toEqual({
      admissionNo: 'GVS-1',
      firstName: 'Diya',
      lastName: 'Shetty',
      gender: 2,
      dateOfBirth: '2014-03-09',
      bloodGroup: 'O+',
      nationality: 'Indian',
      photoFileId: null,
      admissionDate: '2026-06-01',
      mobile: '******1234',
      alternateNumber: '******1235',
      addressLines: 1,
      countryId: 'country-1',
      stateId: null,
      cityId: null,
      pincode: '560001',
      academicYearId: 'year-1',
      classId: 'class-1',
      sectionId: 'section-1',
      rollNumber: '14',
      placementStartDate: '2026-06-01',
      guardians: [
        {
          firstName: 'Ravi',
          lastName: 'Shetty',
          relation: 1,
          phone: '******2345',
          hasLogin: true,
          isPrimary: true,
          isEmergencyContact: false,
        },
      ],
      status: 1,
      inactiveReason: null,
    });
  });

  it('leaves out every email, address line and whole number', () => {
    const text = JSON.stringify(studentAuditView(student(), placed, [guardian()]));
    for (const secret of [
      'diya@example.com',
      'ravi@example.com',
      '4 Temple Street',
      '9876501234',
      '9845012345',
      '9845012346',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('shows no mobile or alternate number as null, a guardian without a login, and no placement as empty', () => {
    const view = studentAuditView(
      student({
        country_code: null,
        mobile_number: null,
        alternate_number: null,
        address_line_1: null,
      }),
      undefined,
      [guardian({ user_id: null, email: null })],
    );
    expect(view).toMatchObject({
      mobile: null,
      alternateNumber: null,
      addressLines: 0,
      academicYearId: null,
      classId: null,
      sectionId: null,
      rollNumber: null,
      guardians: [expect.objectContaining({ hasLogin: false })],
    });
  });
});

const refused = (work: () => void) => {
  try {
    work();
  } catch (error) {
    if (error instanceof AppException) {
      return {
        status: error.status as number,
        fields: (error.options.errors ?? []).map(({ field, code }) => ({ field, code })),
      };
    }
    throw error;
  }
  return null;
};

describe('requireValidDates', () => {
  it('passes dates that agree, and no dates', () => {
    expect(refused(() => requireValidDates({}, '2026-11-11'))).toBeNull();
    expect(
      refused(() =>
        requireValidDates({ dateOfBirth: '2014-03-09', admissionDate: '2026-06-01' }, '2026-11-11'),
      ),
    ).toBeNull();
  });

  it('refuses a date of birth that is today or later, or before 1900, and an admission before birth', () => {
    for (const dateOfBirth of ['2026-11-11', '1899-12-31']) {
      expect(refused(() => requireValidDates({ dateOfBirth }, '2026-11-11'))).toEqual({
        status: 400,
        fields: [{ field: 'dateOfBirth', code: 'INVALID_VALUE' }],
      });
    }
    expect(
      refused(() =>
        requireValidDates({ dateOfBirth: '2014-03-09', admissionDate: '2014-03-08' }, '2026-11-11'),
      )?.fields,
    ).toEqual([{ field: 'admissionDate', code: 'INVALID_VALUE' }]);
  });
});

const admittedOn = (admissionDate: string) =>
  refused(() => requireValidDates({ admissionDate, enrolledDate: '2026-06-01' }, '2026-11-11'));

describe('requireValidDates and the day the enrolment began', () => {
  it('takes an admission on or before the first day in the class, and refuses one after it', () => {
    expect(admittedOn('2026-06-01')).toBeNull();
    expect(admittedOn('2026-05-20')).toBeNull();
    expect(admittedOn('2026-06-02')?.fields).toEqual([
      { field: 'admissionDate', code: 'INVALID_VALUE' },
    ]);
    expect(admittedOn('2099-01-01')?.fields).toEqual([
      { field: 'admissionDate', code: 'INVALID_VALUE' },
    ]);
  });

  it('does not look at the enrolment when there is none or no admission date', () => {
    expect(
      refused(() => requireValidDates({ admissionDate: '2099-01-01' }, '2026-11-11')),
    ).toBeNull();
    expect(
      refused(() =>
        requireValidDates({ admissionDate: null, enrolledDate: '2026-06-01' }, '2026-11-11'),
      ),
    ).toBeNull();
  });

  it('reports the admission once when it is before the birth and after the enrolment', () => {
    expect(
      refused(() =>
        requireValidDates(
          { dateOfBirth: '2014-03-09', admissionDate: '2014-03-08', enrolledDate: '2013-01-01' },
          '2026-11-11',
        ),
      )?.fields,
    ).toEqual([{ field: 'admissionDate', code: 'INVALID_VALUE' }]);
  });
});

describe('enrolmentAuditView', () => {
  it('shows an open, active enrolment before the deactivation and the ending after it', () => {
    expect(enrolmentAuditView(undefined)).toEqual({
      placementEndDate: null,
      enrolmentStatus: 1,
      enrolmentLeftDate: null,
      enrolmentOutcome: null,
    });
    expect(
      enrolmentAuditView({ placementEnd: '2026-11-11', status: 1, left: '2026-11-11', outcome: 3 }),
    ).toEqual({
      placementEndDate: '2026-11-11',
      enrolmentStatus: 1,
      enrolmentLeftDate: '2026-11-11',
      enrolmentOutcome: 3,
    });
    expect(
      enrolmentAuditView({ placementEnd: '2026-11-11', status: 0, left: null, outcome: null }),
    ).toMatchObject({ enrolmentStatus: 0, enrolmentLeftDate: null });
  });
});

describe('requireValidMoveDate', () => {
  const END = '2027-03-31';
  it('takes today, the day the placement began, and any day between', () => {
    for (const day of ['2026-11-11', '2026-11-05', '2026-11-08']) {
      expect(refused(() => requireValidMoveDate(day, '2026-11-05', '2026-11-11', END))).toBeNull();
    }
  });

  it('refuses a day in the future and a day before the placement began', () => {
    for (const day of ['2026-11-12', '2026-11-04']) {
      expect(refused(() => requireValidMoveDate(day, '2026-11-05', '2026-11-11', END))).toEqual({
        status: 400,
        fields: [{ field: 'effectiveDate', code: 'INVALID_VALUE' }],
      });
    }
  });

  it('takes the first day of a placement that begins later, and no other day', () => {
    expect(
      refused(() => requireValidMoveDate('2026-12-01', '2026-12-01', '2026-11-11', END)),
    ).toBeNull();
    for (const day of ['2026-11-11', '2026-12-02']) {
      expect(
        refused(() => requireValidMoveDate(day, '2026-12-01', '2026-11-11', END)),
      ).not.toBeNull();
    }
  });

  it('refuses a day after the year ended, even when today is later', () => {
    expect(
      refused(() => requireValidMoveDate('2027-03-31', '2026-06-15', '2027-04-05', END)),
    ).toBeNull();
    expect(
      refused(() => requireValidMoveDate('2027-04-01', '2026-06-15', '2027-04-05', END)),
    ).toEqual({
      status: 400,
      fields: [{ field: 'effectiveDate', code: 'INVALID_VALUE' }],
    });
  });
});

describe('latestMoveDate', () => {
  it('is today, the later first day of the placement, or the end of the year, whichever comes first', () => {
    expect(latestMoveDate('2026-06-15', '2026-11-11', '2027-03-31')).toBe('2026-11-11');
    expect(latestMoveDate('2026-12-01', '2026-11-11', '2027-03-31')).toBe('2026-12-01');
    expect(latestMoveDate('2026-06-15', '2027-04-05', '2027-03-31')).toBe('2027-03-31');
  });
});
