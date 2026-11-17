import type { AuthorRef } from '../../common/http/author-stamps.js';
import type { DiaryEntryRow } from './diary.repository.js';
import { diaryEntryResource, type DiaryNames } from './diary.resource.js';

const row: DiaryEntryRow = {
  id: 'entry-1',
  created_at: new Date('2026-11-17T04:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-11-17T05:00:00.000Z'),
  updated_by: 'person-2',
  version: 2,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  section_id: 'section-1',
  subject_id: 'subject-1',
  staff_member_id: 'staff-1',
  diary_date: '2026-11-17',
  description: 'Exercise 4.2',
};
const names: DiaryNames = {
  subjects: new Map([['subject-1', 'Mathematics']]),
  teachers: new Map([['staff-1', 'Anna Rao']]),
  sections: new Map([['section-1', { displayName: 'A', className: '10th' }]]),
};
const people = new Map<string, AuthorRef>([
  ['person-1', { id: 'person-1', displayName: 'Anna Rao', roleName: 'Teacher' }],
]);

describe('diaryEntryResource', () => {
  it('shows the entry with its names and the author stamps', () => {
    expect(diaryEntryResource(row, names, people)).toEqual({
      id: 'entry-1',
      institutionId: 'inst-1',
      academicYearId: 'year-1',
      sectionId: 'section-1',
      sectionName: 'A',
      className: '10th',
      subject: { id: 'subject-1', name: 'Mathematics' },
      diaryDate: '2026-11-17',
      description: 'Exercise 4.2',
      teacher: { id: 'staff-1', displayName: 'Anna Rao' },
      status: 1,
      version: 2,
      createdBy: { id: 'person-1', displayName: 'Anna Rao', roleName: 'Teacher' },
      createdAt: '2026-11-17T04:00:00.000Z',
      updatedBy: { id: 'person-2', displayName: 'Unknown', roleName: null },
      updatedAt: '2026-11-17T05:00:00.000Z',
    });
  });

  it('has no teacher for an admin’s entry, and no section names where the reader has none', () => {
    const shown = diaryEntryResource(
      { ...row, staff_member_id: null },
      { ...names, sections: new Map() },
      people,
    );
    expect(shown).toMatchObject({ teacher: null, sectionName: null, className: null });
  });

  it('shows an empty name for a subject or teacher nobody could name', () => {
    const shown = diaryEntryResource(
      row,
      { subjects: new Map(), teachers: new Map(), sections: new Map() },
      people,
    );
    expect(shown.subject).toEqual({ id: 'subject-1', name: '' });
    expect(shown.teacher).toEqual({ id: 'staff-1', displayName: '' });
  });
});
