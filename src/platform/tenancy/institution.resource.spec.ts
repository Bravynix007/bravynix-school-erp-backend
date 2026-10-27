import type { InstitutionListRow, InstitutionRow } from './institution.repository.js';
import {
  institutionOption,
  institutionResource,
  institutionSummary,
  peopleOfInstitutions,
} from './institution.resource.js';

const row = (overrides: Partial<InstitutionRow> = {}): InstitutionRow => ({
  id: 'i1',
  created_at: new Date('2026-10-01T00:00:00.000Z'),
  created_by: 'p1',
  updated_at: new Date('2026-10-02T00:00:00.000Z'),
  updated_by: 'p2',
  version: 4,
  status: 1,
  society_id: 's1',
  society_name: 'Sunrise',
  name: 'Green Valley',
  code: 'GVS',
  place: null,
  board_code: null,
  affiliation_number: null,
  gstin: null,
  email: null,
  country_code: null,
  phone_number: null,
  telephone: null,
  address_line_1: '12 Lake Road',
  address_line_2: null,
  pincode: null,
  latitude: null,
  longitude: null,
  ...overrides,
});

const listRow = (overrides: Partial<InstitutionListRow> = {}): InstitutionListRow => ({
  ...row(),
  staff_blocked: false,
  students_blocked: false,
  ...overrides,
});

const people = new Map([
  ['p1', { id: 'p1', displayName: 'Asha Rao', roleName: 'Society Owner' }],
  ['p2', { id: 'p2', displayName: 'R. Nair', roleName: 'Super Admin' }],
]);

describe('Institution resource (API design 10.4c)', () => {
  it('shows every empty field as null; the first address line is always there', () => {
    expect(institutionResource(row(), people)).toMatchObject({
      place: null,
      boardCode: null,
      affiliationNumber: null,
      gstin: null,
      email: null,
      phone: null,
      telephone: null,
      address: { line1: '12 Lake Road', line2: null, pincode: null },
      location: null,
      societyId: 's1',
      version: 4,
    });
  });

  it('shows the phone and the location as numbers', () => {
    const resource = institutionResource(
      row({
        country_code: '91',
        phone_number: '9876543210',
        latitude: '12.971599',
        longitude: '-77.500000',
      }),
      people,
    );
    expect(resource.phone).toEqual({ countryCode: '91', number: '9876543210' });
    expect(resource.location).toEqual({ latitude: 12.971599, longitude: -77.5 });
  });

  it('shows a half-set location or phone as null', () => {
    const resource = institutionResource(row({ latitude: '1.000000', country_code: '91' }), people);
    expect(resource.location).toBeNull();
    expect(resource.phone).toBeNull();
  });

  it('gives the switcher an option and the platform list a summary, both with stamps', () => {
    expect(institutionOption(row(), people)).toEqual({
      id: 'i1',
      code: 'GVS',
      name: 'Green Valley',
      place: null,
      boardCode: null,
      createdBy: people.get('p1'),
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedBy: people.get('p2'),
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(institutionSummary(listRow(), people)).toMatchObject({
      societyId: 's1',
      societyName: 'Sunrise',
      status: 1,
      blockedSections: [],
    });
    expect(
      institutionSummary(listRow({ staff_blocked: true, students_blocked: true }), people)
        .blockedSections,
    ).toEqual(['staff', 'students']);
    expect(institutionSummary(listRow({ students_blocked: true }), people).blockedSections).toEqual(
      ['students'],
    );
  });

  it('lists the people a row names', () => {
    expect(peopleOfInstitutions([row(), row({ updated_by: 'p3' })]).toSorted()).toEqual([
      'p1',
      'p1',
      'p2',
      'p3',
    ]);
  });
});
