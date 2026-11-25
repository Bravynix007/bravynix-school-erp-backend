import type { ExamPaperRow } from './exam-paper.repository.js';
import { examPaperResource, myPaperResource, type PaperNames } from './exam-paper.resource.js';

const row: ExamPaperRow = {
  id: 'paper-1',
  created_at: new Date('2026-11-01T04:00:00.000Z'),
  created_by: null,
  updated_at: new Date('2026-11-02T04:00:00.000Z'),
  updated_by: null,
  version: 3,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  exam_id: 'exam-1',
  section_id: 'section-1',
  subject_id: 'subject-1',
  exam_date: '2026-08-10',
  start_time: '09:00:00',
  end_time: '11:00:00',
  room_name: 'Room 12',
  max_marks: 100,
  passing_marks: 35,
  subject_teacher_staff_member_id: 'staff-1',
  invigilator_staff_member_id: 'staff-2',
};

const names: PaperNames = {
  subjects: new Map([['subject-1', 'Mathematics']]),
  staff: new Map([
    ['staff-1', 'Asha Rao'],
    ['staff-2', 'Dev Nair'],
  ]),
  sections: new Map([['section-1', { displayName: 'A', className: 'Class 5' }]]),
};

describe('examPaperResource', () => {
  it('shows the paper with its times as `HH:MM`, its names and the stamps', () => {
    expect(examPaperResource(row, names, new Map())).toMatchObject({
      id: 'paper-1',
      examId: 'exam-1',
      institutionId: 'inst-1',
      sectionId: 'section-1',
      sectionName: 'A',
      className: 'Class 5',
      subject: { id: 'subject-1', name: 'Mathematics' },
      examDate: '2026-08-10',
      startTime: '09:00',
      endTime: '11:00',
      roomName: 'Room 12',
      maxMarks: 100,
      passingMarks: 35,
      subjectTeacher: { id: 'staff-1', displayName: 'Asha Rao' },
      invigilator: { id: 'staff-2', displayName: 'Dev Nair' },
      status: 1,
      version: 3,
      createdAt: '2026-11-01T04:00:00.000Z',
      updatedAt: '2026-11-02T04:00:00.000Z',
    });
  });

  it('shows no room, teacher or invigilator that the paper has none of', () => {
    const bare = {
      ...row,
      room_name: null,
      subject_teacher_staff_member_id: null,
      invigilator_staff_member_id: null,
    };
    expect(examPaperResource(bare, names, new Map())).toMatchObject({
      roomName: null,
      subjectTeacher: null,
      invigilator: null,
    });
  });

  it('shows a parent when and where, and neither the people nor the section’s name', () => {
    const forParent = examPaperResource(
      row,
      { subjects: names.subjects, staff: new Map(), sections: new Map() },
      new Map(),
      true,
    );
    expect(forParent).toMatchObject({
      sectionName: null,
      className: null,
      subject: { name: 'Mathematics' },
      startTime: '09:00',
      roomName: 'Room 12',
      subjectTeacher: null,
      invigilator: null,
    });
  });
});

describe('myPaperResource', () => {
  const mine = { ...row, exam_name: 'Unit Test 1' };

  it('shows the exam and the duty of a subject teacher', () => {
    expect(myPaperResource(mine, 'staff-1', names, new Map())).toMatchObject({
      id: 'paper-1',
      exam: { id: 'exam-1', name: 'Unit Test 1' },
      duties: ['subjectTeacher'],
    });
  });

  it('shows an invigilator’s duty, and both for one person who does both', () => {
    expect(myPaperResource(mine, 'staff-2', names, new Map()).duties).toEqual(['invigilator']);
    const both = { ...mine, invigilator_staff_member_id: 'staff-1' };
    expect(myPaperResource(both, 'staff-1', names, new Map()).duties).toEqual([
      'subjectTeacher',
      'invigilator',
    ]);
  });
});
