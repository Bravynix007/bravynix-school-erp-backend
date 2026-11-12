import type { GuardianRow, PlacedRow, StudentListRow, StudentRow } from './student.repository.js';
import { guardianResource, studentResource, studentSummary } from './student.resource.js';

const stamps = {
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'owner-1',
  updated_at: new Date('2026-11-02T00:00:00.000Z'),
  updated_by: null,
};

const student = (overrides: Partial<StudentRow> = {}): StudentRow =>
  ({
    id: 'student-1',
    institution_id: 'institution-1',
    version: 3,
    status: 1,
    admission_no: 'GVS-1',
    first_name: 'Diya',
    last_name: null,
    gender: 2,
    date_of_birth: '2014-03-09',
    blood_group: null,
    nationality: null,
    photo_file_id: 'photo-1',
    admission_date: '2026-06-01',
    contact_email: 'diya@example.com',
    country_code: '91',
    mobile_number: '9876501234',
    alternate_number: null,
    address_line_1: '4 Temple Street',
    address_line_2: null,
    country_id: null,
    state_id: null,
    city_id: null,
    pincode: null,
    ...stamps,
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
  enrolled_date: '2026-05-20',
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
    alternate_phone: null,
    email: 'ravi@example.com',
    occupation: null,
    is_primary: true,
    is_emergency_contact: true,
    ...overrides,
  }) as GuardianRow;

const people = new Map([
  ['owner-1', { id: 'owner-1', displayName: 'Asha Rao', roleName: 'Society Owner' }],
]);

describe('studentResource', () => {
  it('gives the record, where the child sits, the guardians and the stamps', () => {
    expect(studentResource(student(), placed, [guardian()], undefined, people)).toEqual({
      id: 'student-1',
      institutionId: 'institution-1',
      admissionNo: 'GVS-1',
      firstName: 'Diya',
      lastName: null,
      gender: 2,
      dateOfBirth: '2014-03-09',
      bloodGroup: null,
      nationality: null,
      photoFileId: 'photo-1',
      admissionDate: '2026-06-01',
      contactEmail: 'diya@example.com',
      mobile: { countryCode: '91', number: '9876501234' },
      alternateNumber: null,
      address: {
        line1: '4 Temple Street',
        line2: null,
        countryId: null,
        stateId: null,
        cityId: null,
        pincode: null,
      },
      placement: {
        enrolmentId: 'enrolment-1',
        academicYearId: 'year-1',
        classId: 'class-1',
        sectionId: 'section-1',
        rollNumber: '14',
        enrolledDate: '2026-05-20',
        startDate: '2026-06-01',
      },
      guardians: [
        {
          id: 'guardian-1',
          firstName: 'Ravi',
          lastName: 'Shetty',
          relation: 1,
          phone: { countryCode: '91', number: '9845012345' },
          alternatePhone: null,
          email: 'ravi@example.com',
          occupation: null,
          isPrimary: true,
          isEmergencyContact: true,
          hasLogin: true,
        },
      ],
      identity: { aadhaarMasked: null, birthCertificateNumber: null },
      status: 1,
      version: 3,
      createdBy: { id: 'owner-1', displayName: 'Asha Rao', roleName: 'Society Owner' },
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedBy: { id: null, displayName: 'System', roleName: null },
      updatedAt: '2026-11-02T00:00:00.000Z',
    });
  });

  it('shows no mobile and no placement as null', () => {
    const resource = studentResource(
      student({ country_code: null, mobile_number: null }),
      undefined,
      [],
      undefined,
      people,
    );
    expect(resource).toMatchObject({ mobile: null, placement: null, guardians: [] });
  });
});

describe('guardianResource', () => {
  it('says whether the guardian has a login', () => {
    expect(guardianResource(guardian()).hasLogin).toBe(true);
    expect(guardianResource(guardian({ user_id: null, email: null })).hasLogin).toBe(false);
  });
});

describe('studentSummary', () => {
  it('gives a row of the list: the student and where they sit, and nothing personal', () => {
    const row = { ...student(), ...placed } as StudentListRow;
    expect(studentSummary(row)).toEqual({
      id: 'student-1',
      institutionId: 'institution-1',
      admissionNo: 'GVS-1',
      firstName: 'Diya',
      lastName: null,
      photoFileId: 'photo-1',
      placement: {
        enrolmentId: 'enrolment-1',
        academicYearId: 'year-1',
        classId: 'class-1',
        sectionId: 'section-1',
        rollNumber: '14',
        enrolledDate: '2026-05-20',
        startDate: '2026-06-01',
      },
      status: 1,
      version: 3,
    });
  });
});
