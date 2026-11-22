import type { Tx } from '../../platform/database/index.js';
import { PeopleDiary } from './people-diary.js';
import type { AssignmentRepository } from './assignment.repository.js';
import type { StudentRepository } from './student.repository.js';

const tx = {} as Tx;

function build() {
  const mayWriteDiary = vi.fn<AssignmentRepository['mayWriteDiary']>();
  const openPlacement = vi.fn<StudentRepository['openPlacement']>();
  const placedOn = vi.fn<StudentRepository['placedOn']>();
  const guardianUsersByEnrolment = vi.fn<StudentRepository['guardianUsersByEnrolment']>();
  const diary = new PeopleDiary(
    { mayWriteDiary } as unknown as AssignmentRepository,
    { openPlacement, placedOn, guardianUsersByEnrolment } as unknown as StudentRepository,
  );
  return {
    diary,
    mayWriteDiary,
    openPlacement,
    placedOn,
    guardianUsersByEnrolment,
  };
}

describe('PeopleDiary', () => {
  it('asks the assignments whether the teacher may write', async () => {
    const t = build();
    t.mayWriteDiary.mockResolvedValue(true);
    expect(await t.diary.mayWrite(tx, 'staff-1', 'year-1', 'section-1', 'subject-1')).toBe(true);
    expect(t.mayWriteDiary).toHaveBeenCalledWith(tx, 'staff-1', 'year-1', 'section-1', 'subject-1');
  });

  it('gives the section the child sits in now', async () => {
    const t = build();
    t.openPlacement.mockResolvedValueOnce({ section_id: 'section-1' } as never);
    expect(await t.diary.currentSectionId(tx, 'child-1')).toBe('section-1');
    t.openPlacement.mockResolvedValueOnce(undefined);
    expect(await t.diary.currentSectionId(tx, 'child-2')).toBeUndefined();
  });

  it('gives each guardian with a login of each child in the section, and none for a child with no guardian', async () => {
    const t = build();
    t.placedOn.mockResolvedValue([
      { studentId: 'child-1', studentEnrolmentId: 'enrolment-1' },
      { studentId: 'child-2', studentEnrolmentId: 'enrolment-2' },
      { studentId: 'child-3', studentEnrolmentId: 'enrolment-3' },
    ] as never);
    t.guardianUsersByEnrolment.mockResolvedValue(
      new Map([
        ['enrolment-1', ['user-1', 'user-2']],
        ['enrolment-2', ['user-1']],
      ]),
    );
    expect(await t.diary.receiversOf(tx, 'section-1', '2026-11-17')).toEqual([
      { userId: 'user-1', studentId: 'child-1' },
      { userId: 'user-2', studentId: 'child-1' },
      { userId: 'user-1', studentId: 'child-2' },
    ]);
    expect(t.placedOn).toHaveBeenCalledWith(tx, 'section-1', '2026-11-17');
    expect(t.guardianUsersByEnrolment).toHaveBeenCalledWith(tx, [
      'enrolment-1',
      'enrolment-2',
      'enrolment-3',
    ]);
  });
});
