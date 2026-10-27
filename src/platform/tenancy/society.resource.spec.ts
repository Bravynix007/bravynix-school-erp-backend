import type { SocietyRow } from './society.repository.js';
import { institutionsOf, peopleOf, societyResource, societySummary } from './society.resource.js';

const row = (overrides: Partial<SocietyRow> = {}): SocietyRow => ({
  id: 's1',
  created_at: new Date('2026-10-01T00:00:00.000Z'),
  created_by: 'p1',
  updated_at: new Date('2026-10-02T00:00:00.000Z'),
  updated_by: 'p2',
  version: 3,
  status: 1,
  name: 'Sunrise',
  code: 'SUN',
  description: null,
  email: null,
  country_code: null,
  phone_number: null,
  website: null,
  founded_date: null,
  address_line_1: null,
  address_line_2: null,
  pincode: null,
  institution_count: 2,
  owners_blocked: false,
  ...overrides,
});

const people = new Map([
  ['p1', { id: 'p1', displayName: 'Asha Rao', roleName: 'Super Admin' }],
  ['p2', { id: 'p2', displayName: 'R. Nair', roleName: 'Super Admin' }],
]);

describe('Society resource (API design 10.4b)', () => {
  it('shows every empty field as null, and the address as three nulls', () => {
    expect(societyResource(row(), people)).toMatchObject({
      description: null,
      email: null,
      phone: null,
      website: null,
      foundedDate: null,
      address: { line1: null, line2: null, pincode: null },
      blockedSections: [],
      institutionCount: 2,
      version: 3,
    });
  });

  it('puts the phone parts together, and names the blocked section', () => {
    const resource = societyResource(
      row({ country_code: '91', phone_number: '9876543210', owners_blocked: true }),
      people,
    );
    expect(resource.phone).toEqual({ countryCode: '91', number: '9876543210' });
    expect(resource.blockedSections).toEqual(['owners']);
  });

  it('summarises a row for the list, with its stamps', () => {
    expect(societySummary(row({ owners_blocked: true }), people)).toEqual({
      id: 's1',
      code: 'SUN',
      name: 'Sunrise',
      status: 1,
      blocked: true,
      institutionCount: 2,
      createdBy: people.get('p1'),
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedBy: people.get('p2'),
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('lists the people a row names, once each is for the lookup to fold', () => {
    expect(peopleOf([row(), row({ updated_by: 'p3' })]).toSorted()).toEqual([
      'p1',
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('names the blocked sections of each Institution in the detail', () => {
    const base = { id: 'i', code: 'C', name: 'N', status: 1 };
    expect(
      institutionsOf([
        { ...base, staff_blocked: false, students_blocked: false },
        { ...base, staff_blocked: true, students_blocked: true },
        { ...base, staff_blocked: false, students_blocked: true },
      ]).map((institution) => institution.blockedSections),
    ).toEqual([[], ['staff', 'students'], ['students']]);
  });
});
