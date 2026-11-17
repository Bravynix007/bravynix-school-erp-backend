import type { Tx } from '../../platform/database/index.js';
import { PeopleTimetableStaff } from './people-timetable-staff.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';

const tx = {} as Tx;
const teacher = (overrides: Partial<StaffRow> = {}) =>
  ({
    id: 'staff-1',
    status: 1,
    home_institution_id: 'inst-1',
    access_blocked_at: null,
    ...overrides,
  }) as StaffRow;

function build(found: StaffRow | null = teacher(), subjects: string[] = ['subject-1']) {
  const find = vi.fn<StaffRepository['find']>().mockResolvedValue(found ?? undefined);
  const subjectIds = vi.fn<StaffRepository['subjectIds']>().mockResolvedValue(subjects);
  const activeOfUser = vi
    .fn<StaffRepository['activeOfUser']>()
    .mockResolvedValue(found ?? undefined);
  const namesOf = vi
    .fn<StaffRepository['namesOf']>()
    .mockResolvedValue(
      new Map([['staff-1', { id: 'staff-1', first_name: 'Asha', last_name: 'Rao' }]]),
    );
  const namesForParent = vi
    .fn<StaffRepository['namesForParent']>()
    .mockResolvedValue(
      new Map([['staff-1', { id: 'staff-1', first_name: 'Asha', last_name: null }]]),
    );
  const service = new PeopleTimetableStaff({
    find,
    subjectIds,
    activeOfUser,
    namesOf,
    namesForParent,
  } as unknown as StaffRepository);
  return { service, find, subjectIds, activeOfUser, namesOf, namesForParent };
}

describe('PeopleTimetableStaff.requireTeacher', () => {
  it('passes for an active teacher of the Institution who teaches the subject', async () => {
    await expect(
      build().service.requireTeacher(tx, 'staff-1', 'inst-1', 'subject-1'),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['not found', null, 404, 'NOT_FOUND'],
    ['deactivated', teacher({ status: 0 }), 422, 'REFERENCE_INACTIVE'],
    ['blocked', teacher({ access_blocked_at: new Date() }), 422, 'STAFF_BLOCKED'],
    [
      'at another home Institution',
      teacher({ home_institution_id: 'inst-2' }),
      422,
      'STAFF_NOT_AT_INSTITUTION',
    ],
  ])('refuses a teacher who is %s', async (_name, found, status, code) => {
    await expect(
      build(found).service.requireTeacher(tx, 'staff-1', 'inst-1', 'subject-1'),
    ).rejects.toMatchObject({ status, code });
  });

  it('is 422 SUBJECT_NOT_TAUGHT for a subject the teacher cannot teach', async () => {
    await expect(
      build(teacher(), ['subject-2']).service.requireTeacher(tx, 'staff-1', 'inst-1', 'subject-1'),
    ).rejects.toMatchObject({ status: 422, code: 'SUBJECT_NOT_TAUGHT' });
  });
});

describe('PeopleTimetableStaff.ownRecord', () => {
  it('is the staff ID and home Institution of the person, or nothing', async () => {
    expect(await build().service.ownRecord(tx, 'person-1')).toEqual({
      staffMemberId: 'staff-1',
      homeInstitutionId: 'inst-1',
    });
    const none = build();
    none.activeOfUser.mockResolvedValue(undefined);
    expect(await none.service.ownRecord(tx, 'person-1')).toBeUndefined();
  });
});

describe('PeopleTimetableStaff names', () => {
  it('writes first and last name, from the scope the caller has', async () => {
    const t = build();
    expect(await t.service.names(tx, ['staff-1'])).toEqual(new Map([['staff-1', 'Asha Rao']]));
    expect(t.namesOf).toHaveBeenCalledWith(tx, ['staff-1']);
  });

  it('reads a parent’s names through the names-only function, and drops a missing last name', async () => {
    const t = build();
    expect(await t.service.namesForParent(tx, ['staff-1'])).toEqual(new Map([['staff-1', 'Asha']]));
    expect(t.namesForParent).toHaveBeenCalledWith(tx, ['staff-1']);
    expect(t.namesOf).not.toHaveBeenCalled();
  });
});
