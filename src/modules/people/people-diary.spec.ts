import type { Tx } from '../../platform/database/index.js';
import { PeopleDiary } from './people-diary.js';
import type { AssignmentRepository } from './assignment.repository.js';
import type { StaffName, StaffRepository } from './staff.repository.js';
import type { StudentRepository } from './student.repository.js';

const tx = {} as Tx;
const name = (first: string, last: string | null) =>
  ({ first_name: first, last_name: last }) as StaffName;

function build() {
  const activeOfUser = vi.fn<StaffRepository['activeOfUser']>();
  const namesOf = vi.fn<StaffRepository['namesOf']>();
  const namesForParent = vi.fn<StaffRepository['namesForParent']>();
  const mayWriteDiary = vi.fn<AssignmentRepository['mayWriteDiary']>();
  const openPlacement = vi.fn<StudentRepository['openPlacement']>();
  const placedOn = vi.fn<StudentRepository['placedOn']>();
  const guardianUsersByEnrolment = vi.fn<StudentRepository['guardianUsersByEnrolment']>();
  const diary = new PeopleDiary(
    { activeOfUser, namesOf, namesForParent } as unknown as StaffRepository,
    { mayWriteDiary } as unknown as AssignmentRepository,
    { openPlacement, placedOn, guardianUsersByEnrolment } as unknown as StudentRepository,
  );
  return {
    diary,
    activeOfUser,
    namesOf,
    namesForParent,
    mayWriteDiary,
    openPlacement,
    placedOn,
    guardianUsersByEnrolment,
  };
}

describe('PeopleDiary', () => {
  it('gives the staff record of the person and its home Institution, or nothing', async () => {
    const t = build();
    t.activeOfUser.mockResolvedValueOnce({ id: 'staff-1', home_institution_id: 'inst-1' } as never);
    expect(await t.diary.ownRecord(tx, 'person-1')).toEqual({
      staffMemberId: 'staff-1',
      homeInstitutionId: 'inst-1',
    });
    t.activeOfUser.mockResolvedValueOnce(undefined);
    expect(await t.diary.ownRecord(tx, 'person-2')).toBeUndefined();
  });

  it('asks the assignments whether the teacher may write', async () => {
    const t = build();
    t.mayWriteDiary.mockResolvedValue(true);
    expect(await t.diary.mayWrite(tx, 'staff-1', 'year-1', 'section-1', 'subject-1')).toBe(true);
    expect(t.mayWriteDiary).toHaveBeenCalledWith(tx, 'staff-1', 'year-1', 'section-1', 'subject-1');
  });

  it('names teachers by their first and last name, for a staff member and for a parent', async () => {
    const t = build();
    t.namesOf.mockResolvedValue(
      new Map([
        ['a', name('Anna', 'Rao')],
        ['b', name('Ben', null)],
      ]),
    );
    t.namesForParent.mockResolvedValue(new Map([['a', name('Anna', '')]]));
    expect(await t.diary.names(tx, ['a', 'b'])).toEqual(
      new Map([
        ['a', 'Anna Rao'],
        ['b', 'Ben'],
      ]),
    );
    expect(await t.diary.namesForParent(tx, ['a'])).toEqual(new Map([['a', 'Anna']]));
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
