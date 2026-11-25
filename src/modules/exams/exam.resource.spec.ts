import type { ExamRow } from './exam.repository.js';
import { examResource } from './exam.resource.js';

const row: ExamRow = {
  id: 'exam-1',
  created_at: new Date('2026-11-01T04:00:00.000Z'),
  created_by: null,
  updated_at: new Date('2026-11-02T04:00:00.000Z'),
  updated_by: null,
  version: 2,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  name: 'Unit Test 1',
  exam_type: 1,
  start_date: '2026-08-10',
  end_date: '2026-08-14',
  datesheet_published_at: null,
  datesheet_published_by: null,
};

describe('examResource', () => {
  it('shows the exam with its dates as written and carries the stamps', () => {
    expect(examResource(row, new Map())).toMatchObject({
      id: 'exam-1',
      institutionId: 'inst-1',
      academicYearId: 'year-1',
      name: 'Unit Test 1',
      examType: 1,
      startDate: '2026-08-10',
      endDate: '2026-08-14',
      datesheetPublishedAt: null,
      status: 1,
      version: 2,
      createdAt: '2026-11-01T04:00:00.000Z',
      updatedAt: '2026-11-02T04:00:00.000Z',
    });
  });

  it('shows when the datesheet was published', () => {
    const published = { ...row, datesheet_published_at: new Date('2026-11-03T05:30:00.000Z') };
    expect(examResource(published, new Map()).datesheetPublishedAt).toBe(
      '2026-11-03T05:30:00.000Z',
    );
  });
});
