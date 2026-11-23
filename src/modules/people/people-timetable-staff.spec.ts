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
  const service = new PeopleTimetableStaff({ find, subjectIds } as unknown as StaffRepository);
  return { service, find, subjectIds };
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
