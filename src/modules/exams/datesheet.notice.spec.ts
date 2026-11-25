import type { ExamPaperRow } from './exam-paper.repository.js';
import type { ExamRow } from './exam.repository.js';
import { paperNotice, publishedNotice } from './datesheet.notice.js';

const exam = {
  id: 'exam-1',
  society_id: 'society-1',
  institution_id: 'inst-1',
  name: 'Unit Test 1',
  start_date: '2026-08-10',
  end_date: '2026-08-14',
  updated_at: new Date('2026-08-01T04:00:00.000Z'),
} as ExamRow;
const paper = {
  id: 'paper-1',
  version: 3,
  created_at: new Date('2026-07-01T04:00:00.000Z'),
  updated_at: new Date('2026-08-02T04:00:00.000Z'),
} as ExamPaperRow;
const receivers = [{ userId: 'user-1', studentId: 'child-1' }, { userId: 'user-2' }];

describe('publishedNotice', () => {
  it('tells the exam and its days, opening the exam, to the receivers only for them', () => {
    expect(publishedNotice(exam, receivers)).toEqual({
      societyId: 'society-1',
      institutionId: 'inst-1',
      sourceKey: 'datesheet:exam-1',
      occurredAt: exam.updated_at,
      category: 4,
      tab: 1,
      title: 'Exam datesheet published',
      body: 'Unit Test 1: 10 Aug 2026 to 14 Aug 2026.',
      target: { type: 4, id: 'exam-1' },
      receivers,
    });
  });

  it('names a one-day exam by its day', () => {
    const oneDay = { ...exam, end_date: '2026-08-10' } as ExamRow;
    expect(publishedNotice(oneDay, []).body).toBe('Unit Test 1: 10 Aug 2026.');
  });
});

describe('paperNotice', () => {
  it('keys the notice by the paper and its version, so each change is a new one', () => {
    const notice = paperNotice(exam, paper, 'Mathematics', 'changed', receivers);
    expect(notice).toMatchObject({
      sourceKey: 'datesheet-paper:paper-1:v3',
      occurredAt: paper.updated_at,
      category: 4,
      title: 'Exam datesheet updated',
      body: 'Unit Test 1: the Mathematics paper was changed.',
      target: { type: 4, id: 'exam-1' },
    });
  });

  it('dates an added paper by when it was added, and never tells marks or people', () => {
    const notice = paperNotice(exam, paper, 'Mathematics', 'added', receivers);
    expect(notice.occurredAt).toBe(paper.created_at);
    expect(notice.body).toBe('Unit Test 1: the Mathematics paper was added.');
    expect(paperNotice(exam, paper, 'Mathematics', 'removed', []).body).toContain('removed');
  });
});
