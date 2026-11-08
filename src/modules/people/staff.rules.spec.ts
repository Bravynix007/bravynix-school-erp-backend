import { AppException } from '../../common/http/app-exception.js';
import type { EducationRow, EmergencyContactRow, StaffRow } from './staff.repository.js';
import { requireValidStaff, staffAuditView } from './staff.rules.js';

const problemsOf = (input: Parameters<typeof requireValidStaff>[0]) => {
  try {
    requireValidStaff(input, '2026-11-08');
  } catch (error) {
    if (error instanceof AppException) {
      return (error.options.errors ?? []).map(({ field, code }) => ({ field, code }));
    }
    throw error;
  }
  return [];
};

describe('requireValidStaff', () => {
  it('passes a record with no dates and no contacts', () => {
    expect(problemsOf({})).toEqual([]);
    expect(problemsOf({ dateOfBirth: null, joiningDate: null, resignationDate: null })).toEqual([]);
  });

  it('wants the date of birth before today', () => {
    expect(problemsOf({ dateOfBirth: '2026-11-07' })).toEqual([]);
    for (const day of ['2026-11-08', '2027-01-01']) {
      expect(problemsOf({ dateOfBirth: day })).toEqual([
        { field: 'dateOfBirth', code: 'INVALID_VALUE' },
      ]);
    }
  });

  it('lets the resignation fall on the joining date but not before it, and only when both are known', () => {
    expect(problemsOf({ joiningDate: '2024-06-03', resignationDate: '2024-06-03' })).toEqual([]);
    expect(problemsOf({ joiningDate: '2024-06-03', resignationDate: '2024-06-02' })).toEqual([
      { field: 'resignationDate', code: 'INVALID_VALUE' },
    ]);
    expect(problemsOf({ resignationDate: '2020-01-01' })).toEqual([]);
    expect(problemsOf({ joiningDate: '2024-06-03', resignationDate: null })).toEqual([]);
  });

  it('allows one primary contact and names each further one by its place in the list', () => {
    expect(problemsOf({ emergencyContacts: [{ isPrimary: false }, { isPrimary: true }] })).toEqual(
      [],
    );
    expect(
      problemsOf({
        emergencyContacts: [
          { isPrimary: true },
          { isPrimary: false },
          { isPrimary: true },
          { isPrimary: true },
        ],
      }),
    ).toEqual([
      { field: 'emergencyContacts[2].isPrimary', code: 'INVALID_VALUE' },
      { field: 'emergencyContacts[3].isPrimary', code: 'INVALID_VALUE' },
    ]);
  });

  it('reports every broken rule at once, in the order of the form', () => {
    expect(
      problemsOf({
        dateOfBirth: '2030-01-01',
        joiningDate: '2024-06-03',
        resignationDate: '2024-01-01',
        emergencyContacts: [{ isPrimary: true }, { isPrimary: true }],
      }).map((p) => p.field),
    ).toEqual(['dateOfBirth', 'resignationDate', 'emergencyContacts[1].isPrimary']);
  });
});

const row: StaffRow = {
  id: 'staff-1',
  created_at: new Date('2026-11-01T00:00:00Z'),
  created_by: 'owner-1',
  updated_at: new Date('2026-11-01T00:00:00Z'),
  updated_by: 'owner-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  home_institution_id: 'institution-1',
  user_id: 'user-1',
  employee_code: 'EMP-1',
  first_name: 'Meera',
  last_name: 'Iyer',
  gender: 2,
  date_of_birth: '1990-04-12',
  blood_group: 'O+',
  nationality: 'Indian',
  photo_file_id: null,
  designation_id: null,
  class_category_id: 'category-1',
  country_code: '91',
  mobile_number: '9876500001',
  alternate_phone: '9876500002',
  address_line_1: '4 Temple Street',
  address_line_2: null,
  country_id: null,
  state_id: null,
  city_id: null,
  pincode: '560001',
  joining_date: '2024-06-03',
  resignation_date: null,
  employment_type: 1,
};

describe('staffAuditView', () => {
  const education = { degree: 'B.Ed', year_of_passing: 2014, institution_name: 'IISc' };
  const contact = {
    contact_name: 'Ravi Iyer',
    phone_number: '9876500003',
    alternate_phone: '9876500004',
    is_primary: true,
  };
  const view = staffAuditView(
    row,
    [education as EducationRow],
    [contact as unknown as EmergencyContactRow],
  );

  it('keeps names, codes and dates, and the lists by their headings', () => {
    expect(view).toMatchObject({
      employeeCode: 'EMP-1',
      firstName: 'Meera',
      dateOfBirth: '1990-04-12',
      status: 1,
      educations: [{ degree: 'B.Ed', yearOfPassing: 2014 }],
      emergencyContacts: [{ contactName: 'Ravi Iyer', isPrimary: true }],
    });
  });

  it('shows a phone number as its last four digits, and the address lines as a count', () => {
    expect(view).toMatchObject({
      mobile: '******0001',
      alternatePhone: '******0002',
      addressLines: 1,
    });
    expect(staffAuditView({ ...row, alternate_phone: null }, [], [])).toMatchObject({
      alternatePhone: null,
    });
    expect(staffAuditView({ ...row, address_line_2: 'Block B' }, [], [])).toMatchObject({
      addressLines: 2,
    });
  });

  it('leaves out the numbers and the address of the contacts, so no personal detail is kept', () => {
    const text = JSON.stringify(view);
    for (const secret of [
      '9876500001',
      '9876500002',
      '9876500003',
      '9876500004',
      'Temple',
      'IISc',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
