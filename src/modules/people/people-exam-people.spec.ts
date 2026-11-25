import type { Tx } from '../../platform/database/index.js';
import { PeopleExamPeople } from './people-exam-people.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';

const tx = {} as Tx;
const member = (overrides: Partial<StaffRow> = {}) =>
  ({
    id: 'staff-1',
    status: 1,
    home_institution_id: 'inst-1',
    access_blocked_at: null,
    ...overrides,
  }) as StaffRow;

function build(found: StaffRow | null = member(), subjects: string[] = ['subject-1']) {
  const find = vi.fn<StaffRepository['find']>().mockResolvedValue(found ?? undefined);
  const subjectIds = vi.fn<StaffRepository['subjectIds']>().mockResolvedValue(subjects);
  return new PeopleExamPeople({ find, subjectIds } as unknown as StaffRepository);
}

const refusals = [
  ['not found', null, 404, 'NOT_FOUND'],
  ['deactivated', member({ status: 0 }), 422, 'REFERENCE_INACTIVE'],
  ['blocked', member({ access_blocked_at: new Date() }), 422, 'STAFF_BLOCKED'],
  [
    'at another home Institution',
    member({ home_institution_id: 'inst-2' }),
    422,
    'STAFF_NOT_AT_INSTITUTION',
  ],
] as const;

describe('PeopleExamPeople.requireSubjectTeacher', () => {
  it('passes for an active teacher of the Institution who teaches the subject', async () => {
    await expect(
      build().requireSubjectTeacher(tx, 'staff-1', 'inst-1', 'subject-1', 'teacherField'),
    ).resolves.toBeUndefined();
  });

  it.each(refusals)('refuses a teacher who is %s', async (_name, found, status, code) => {
    await expect(
      build(found).requireSubjectTeacher(tx, 'staff-1', 'inst-1', 'subject-1', 'teacherField'),
    ).rejects.toMatchObject({ status, code });
  });

  it('names the field of a deactivated teacher, and refuses a subject they cannot teach', async () => {
    await expect(
      build(member({ status: 0 })).requireSubjectTeacher(
        tx,
        'staff-1',
        'inst-1',
        'subject-1',
        'teacherField',
      ),
    ).rejects.toMatchObject({ options: { errors: [{ field: 'teacherField' }] } });
    await expect(
      build(member(), ['subject-2']).requireSubjectTeacher(
        tx,
        'staff-1',
        'inst-1',
        'subject-1',
        'teacherField',
      ),
    ).rejects.toMatchObject({ status: 422, code: 'SUBJECT_NOT_TAUGHT' });
  });
});

describe('PeopleExamPeople.requireInvigilator', () => {
  it('passes for any active staff member of the Institution, whatever they teach', async () => {
    await expect(
      build(member(), []).requireInvigilator(tx, 'staff-1', 'inst-1', 'invigilatorField'),
    ).resolves.toBeUndefined();
  });

  it.each(refusals)('refuses a staff member who is %s', async (_name, found, status, code) => {
    await expect(
      build(found).requireInvigilator(tx, 'staff-1', 'inst-1', 'invigilatorField'),
    ).rejects.toMatchObject({ status, code });
  });
});
