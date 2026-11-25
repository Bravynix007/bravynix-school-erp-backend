import { FixedClock } from '../../common/time/clock.js';
import type { Tx } from '../../platform/database/index.js';
import type { Notice, Notifications } from '../../platform/notifications/index.js';
import type { SubjectDirectory } from '../academic-setup/index.js';
import type { ExamPaperRow } from './exam-paper.repository.js';
import type { ExamPeople } from './exam-people.js';
import type { ExamRow } from './exam.repository.js';
import { DatesheetNotifier } from './datesheet.notifier.js';

const tx = {} as Tx;
const exam = {
  id: 'exam-1',
  society_id: 'society-1',
  institution_id: 'inst-1',
  name: 'Unit Test 1',
  start_date: '2026-08-10',
  end_date: '2026-08-14',
  updated_at: new Date('2026-08-01T04:00:00.000Z'),
} as ExamRow;
const paper = (fields: Partial<ExamPaperRow> = {}) =>
  ({
    id: 'paper-1',
    version: 1,
    section_id: 'section-1',
    subject_id: 'subject-1',
    subject_teacher_staff_member_id: 'staff-1',
    invigilator_staff_member_id: null,
    created_at: new Date('2026-07-01T04:00:00.000Z'),
    updated_at: new Date('2026-07-01T04:00:00.000Z'),
    ...fields,
  }) as ExamPaperRow;

function build(
  options: {
    guardians?: Record<string, { userId: string; studentId: string }[]>;
    staff?: string[];
  } = {},
) {
  const notified: Notice[] = [];
  const notify = vi.fn<Notifications['notify']>((_tx, notice) => {
    notified.push(notice);
    return Promise.resolve('job');
  });
  const guardianReceivers = vi.fn<ExamPeople['guardianReceivers']>((_tx, sectionId) =>
    Promise.resolve(options.guardians?.[sectionId] ?? []),
  );
  const staffUserIds = vi.fn<ExamPeople['staffUserIds']>().mockResolvedValue(options.staff ?? []);
  const subjectNames = vi
    .fn<SubjectDirectory['names']>()
    .mockResolvedValue(new Map([['subject-1', 'Mathematics']]));
  const notifier = new DatesheetNotifier(
    { notify } as unknown as Notifications,
    { guardianReceivers, staffUserIds } as unknown as ExamPeople,
    { names: subjectNames } as unknown as SubjectDirectory,
    new FixedClock('2026-08-01T04:30:00.000Z'),
  );
  return { notifier, notified, notify, guardianReceivers, staffUserIds };
}

describe('DatesheetNotifier.published', () => {
  it('tells the guardians of each section with a paper, once, and the staff on the papers', async () => {
    const { notifier, notified, guardianReceivers, staffUserIds } = build({
      guardians: {
        'section-1': [{ userId: 'mother', studentId: 'child-1' }],
        'section-2': [
          { userId: 'mother', studentId: 'child-1' },
          { userId: 'aunt', studentId: 'child-2' },
          { userId: 'mother', studentId: 'child-3' },
        ],
      },
      staff: ['teacher-user'],
    });
    await notifier.published(
      tx,
      exam,
      [
        paper(),
        paper({ id: 'paper-2', section_id: 'section-2', invigilator_staff_member_id: 'staff-2' }),
        paper({ id: 'paper-3', section_id: 'section-1' }),
      ],
      'admin-1',
    );
    expect(guardianReceivers.mock.calls.map((call) => call[1])).toEqual(['section-1', 'section-2']);
    expect(guardianReceivers).toHaveBeenCalledWith(tx, 'section-1', '2026-08-01');
    expect(staffUserIds).toHaveBeenCalledWith(tx, ['staff-1', 'staff-2']);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      sourceKey: 'datesheet:exam-1',
      title: 'Exam datesheet published',
    });
    expect(notified[0]!.receivers).toEqual([
      { userId: 'mother', studentId: 'child-1' },
      { userId: 'aunt', studentId: 'child-2' },
      { userId: 'mother', studentId: 'child-3' },
      { userId: 'teacher-user' },
    ]);
  });

  it('sends nothing when no one is to be told', async () => {
    const { notifier, notify } = build();
    await notifier.published(
      tx,
      exam,
      [paper({ subject_teacher_staff_member_id: null })],
      'admin-1',
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('splits an audience larger than one notice may name, each part with its own key', async () => {
    const many = Array.from({ length: 5001 }, (_, n) => ({
      userId: `user-${n.toString()}`,
      studentId: `child-${n.toString()}`,
    }));
    const { notifier, notified } = build({ guardians: { 'section-1': many } });
    await notifier.published(
      tx,
      exam,
      [paper({ subject_teacher_staff_member_id: null })],
      'admin-1',
    );
    expect(notified.map((n) => [n.sourceKey, n.receivers.length])).toEqual([
      ['datesheet:exam-1', 5000],
      ['datesheet:exam-1:1', 1],
    ]);
  });
});

describe('DatesheetNotifier.changed', () => {
  it('tells the paper’s section and the staff on it, and the staff it no longer has', async () => {
    const { notifier, notified, staffUserIds } = build({
      guardians: { 'section-1': [{ userId: 'mother', studentId: 'child-1' }] },
      staff: ['teacher-user'],
    });
    await notifier.changed(
      tx,
      exam,
      paper({ version: 2 }),
      'changed',
      ['staff-1', 'staff-9', null],
      'admin-1',
    );
    expect(staffUserIds).toHaveBeenCalledWith(tx, ['staff-1', 'staff-9']);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      sourceKey: 'datesheet-paper:paper-1:v2',
      body: 'Unit Test 1: the Mathematics paper was changed.',
    });
    expect(notified[0]!.receivers).toHaveLength(2);
  });

  it('sends nothing for a section with no guardians and a paper with no staff', async () => {
    const { notifier, notify } = build();
    await notifier.changed(
      tx,
      exam,
      paper({ subject_teacher_staff_member_id: null }),
      'removed',
      [],
      'admin-1',
    );
    expect(notify).not.toHaveBeenCalled();
  });
});
