import type { AuthorRef } from '../../common/http/author-stamps.js';
import type { EducationRow, EmergencyContactRow, StaffRow } from './staff.repository.js';
import { staffResource } from './staff.resource.js';

const row = {
  id: 'staff-1',
  created_at: new Date('2026-06-01T05:00:00Z'),
  created_by: 'owner-1',
  updated_at: new Date('2026-06-02T05:00:00Z'),
  updated_by: 'admin-1',
  version: 3,
  status: 1,
  society_id: 'society-1',
  home_institution_id: 'institution-1',
  user_id: 'user-1',
  employee_code: 'EMP-1',
  first_name: 'Meera',
  last_name: null,
  gender: 2,
  date_of_birth: '1990-04-12',
  blood_group: 'O+',
  nationality: null,
  photo_file_id: 'file-1',
  designation_id: null,
  class_category_id: 'category-1',
  country_code: '91',
  mobile_number: '9876500001',
  alternate_phone: null,
  address_line_1: '4 Temple Street',
  address_line_2: null,
  country_id: 'country-1',
  state_id: 'state-1',
  city_id: 'city-1',
  pincode: '560001',
  joining_date: '2024-06-03',
  resignation_date: null,
  employment_type: 1,
} as StaffRow;

describe('staffResource', () => {
  it('shows the record under its API names, with the login, the lists and the author stamps', () => {
    const people = new Map<string, AuthorRef>([
      ['owner-1', { id: 'owner-1', displayName: 'Asha Rao', roleName: 'Society Owner' }],
      ['admin-1', { id: 'admin-1', displayName: 'Ravi', roleName: 'Institution Admin' }],
    ]);
    const educations = [
      {
        degree: 'B.Ed',
        qualification: null,
        specialization: 'Physics',
        institution_name: 'IISc',
        year_of_passing: 2014,
      },
    ] as EducationRow[];
    const contacts = [
      {
        contact_name: 'Ravi Iyer',
        relation: 'Spouse',
        country_code: '91',
        phone_number: '9876500003',
        alternate_phone: null,
        is_primary: true,
      },
    ] as EmergencyContactRow[];
    expect(staffResource(row, educations, contacts, 'meera@example.com', people)).toEqual({
      id: 'staff-1',
      homeInstitutionId: 'institution-1',
      person: { id: 'user-1', email: 'meera@example.com' },
      employeeCode: 'EMP-1',
      firstName: 'Meera',
      lastName: null,
      gender: 2,
      dateOfBirth: '1990-04-12',
      bloodGroup: 'O+',
      nationality: null,
      photoFileId: 'file-1',
      designationId: null,
      classCategoryId: 'category-1',
      mobile: { countryCode: '91', number: '9876500001' },
      alternateNumber: null,
      address: {
        line1: '4 Temple Street',
        line2: null,
        countryId: 'country-1',
        stateId: 'state-1',
        cityId: 'city-1',
        pincode: '560001',
      },
      joiningDate: '2024-06-03',
      resignationDate: null,
      employmentType: 1,
      educations: [
        {
          degree: 'B.Ed',
          qualification: null,
          specialization: 'Physics',
          institutionName: 'IISc',
          yearOfPassing: 2014,
        },
      ],
      emergencyContacts: [
        {
          contactName: 'Ravi Iyer',
          relation: 'Spouse',
          phone: { countryCode: '91', number: '9876500003' },
          alternateNumber: null,
          isPrimary: true,
        },
      ],
      status: 1,
      version: 3,
      createdBy: { id: 'owner-1', displayName: 'Asha Rao', roleName: 'Society Owner' },
      createdAt: '2026-06-01T05:00:00.000Z',
      updatedBy: { id: 'admin-1', displayName: 'Ravi', roleName: 'Institution Admin' },
      updatedAt: '2026-06-02T05:00:00.000Z',
    });
  });
});
