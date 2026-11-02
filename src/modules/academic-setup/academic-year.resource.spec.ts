import type { AuthorRef } from '../../common/http/author-stamps.js';
import type { AcademicYearRow } from './academic-year.repository.js';
import { academicYearResource, peopleOfYears } from './academic-year.resource.js';

const row: AcademicYearRow = {
  id: '0192f3b0-0000-7000-8000-000000000001',
  created_at: new Date('2026-06-01T05:00:00Z'),
  created_by: '0192f3b0-0000-7000-8000-0000000000aa',
  updated_at: new Date('2026-06-02T05:00:00Z'),
  updated_by: null,
  version: 2,
  status: 1,
  society_id: '0192f3b0-0000-7000-8000-0000000000b1',
  institution_id: '0192f3b0-0000-7000-8000-0000000000b2',
  name: '2026-2027',
  start_date: '2026-06-01',
  end_date: '2027-03-31',
  is_current: true,
};

describe('academicYearResource', () => {
  it('shows the year under its API names, with the author stamps', () => {
    const people = new Map<string, AuthorRef>([
      [row.created_by!, { id: row.created_by, displayName: 'Asha Rao', roleName: 'Society Owner' }],
    ]);
    expect(academicYearResource(row, people)).toEqual({
      id: row.id,
      institutionId: row.institution_id,
      name: '2026-2027',
      startDate: '2026-06-01',
      endDate: '2027-03-31',
      isCurrent: true,
      status: 1,
      version: 2,
      createdBy: { id: row.created_by, displayName: 'Asha Rao', roleName: 'Society Owner' },
      createdAt: '2026-06-01T05:00:00.000Z',
      updatedBy: { id: null, displayName: 'System', roleName: null },
      updatedAt: '2026-06-02T05:00:00.000Z',
    });
  });
});

describe('peopleOfYears', () => {
  it('lists each person once and leaves out an empty author', () => {
    const other = { ...row, id: 'x', created_by: row.created_by, updated_by: 'someone' };
    expect(peopleOfYears([row, other])).toEqual([row.created_by, 'someone']);
    expect(peopleOfYears([])).toEqual([]);
  });
});
