import type { AuthorRef } from '../../common/http/author-stamps.js';
import type { SubjectRow } from './subject.repository.js';
import { peopleOfSubjects, subjectResource } from './subject.resource.js';

const row: SubjectRow = {
  id: '0192f3b0-0000-7000-8000-000000000001',
  created_at: new Date('2026-06-01T05:00:00Z'),
  created_by: '0192f3b0-0000-7000-8000-0000000000aa',
  updated_at: new Date('2026-06-02T05:00:00Z'),
  updated_by: '0192f3b0-0000-7000-8000-0000000000ab',
  version: 3,
  status: 1,
  society_id: '0192f3b0-0000-7000-8000-0000000000b1',
  name: 'Mathematics',
  code: null,
};

describe('subjectResource', () => {
  it('shows the subject under its API names, with the author stamps and no Society', () => {
    const people = new Map<string, AuthorRef>([
      [row.created_by!, { id: row.created_by, displayName: 'Asha Rao', roleName: 'Society Owner' }],
      [row.updated_by!, { id: row.updated_by, displayName: 'Ravi', roleName: 'Institution Admin' }],
    ]);
    expect(subjectResource(row, people)).toEqual({
      id: row.id,
      name: 'Mathematics',
      code: null,
      status: 1,
      version: 3,
      createdBy: { id: row.created_by, displayName: 'Asha Rao', roleName: 'Society Owner' },
      createdAt: '2026-06-01T05:00:00.000Z',
      updatedBy: { id: row.updated_by, displayName: 'Ravi', roleName: 'Institution Admin' },
      updatedAt: '2026-06-02T05:00:00.000Z',
    });
  });
});

describe('peopleOfSubjects', () => {
  it('names each author once and leaves out the missing ones', () => {
    expect(
      peopleOfSubjects([row, { ...row, id: 'x', updated_by: null }, { ...row, created_by: null }]),
    ).toEqual([row.created_by, row.updated_by]);
  });
});
