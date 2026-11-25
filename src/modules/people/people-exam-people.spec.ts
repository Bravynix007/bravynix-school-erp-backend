import type { Tx } from '../../platform/database/index.js';
import { PeopleExamPeople } from './people-exam-people.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';
import type { StudentRepository } from './student.repository.js';

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
  return new PeopleExamPeople(
    { find, subjectIds } as unknown as StaffRepository,
    {} as StudentRepository,
  );
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

const placed = { rollNumber: '1', firstName: 'Asha', lastName: null, photoFileId: null };

describe('PeopleExamPeople notices', () => {
  it('names each guardian with the child, for the students on the roll of the section that day', async () => {
    const placedOn = vi.fn<StudentRepository['placedOn']>().mockResolvedValue([
      { ...placed, studentEnrolmentId: 'enrolment-1', studentId: 'child-1' },
      { ...placed, studentEnrolmentId: 'enrolment-2', studentId: 'child-2' },
    ]);
    const guardianUsersByEnrolment = vi
      .fn<StudentRepository['guardianUsersByEnrolment']>()
      .mockResolvedValue(
        new Map([
          ['enrolment-1', ['mother', 'father']],
          ['enrolment-2', []],
        ]),
      );
    const service = new PeopleExamPeople(
      {} as StaffRepository,
      { placedOn, guardianUsersByEnrolment } as unknown as StudentRepository,
    );
    await expect(service.guardianReceivers(tx, 'section-1', '2026-08-01')).resolves.toEqual([
      { userId: 'mother', studentId: 'child-1' },
      { userId: 'father', studentId: 'child-1' },
    ]);
    expect(placedOn).toHaveBeenCalledWith(tx, 'section-1', '2026-08-01');
    expect(guardianUsersByEnrolment).toHaveBeenCalledWith(tx, ['enrolment-1', 'enrolment-2']);
  });

  it('answers the people behind the staff members', async () => {
    const userIdsOf = vi.fn<StaffRepository['userIdsOf']>().mockResolvedValue(['user-1']);
    const service = new PeopleExamPeople(
      { userIdsOf } as unknown as StaffRepository,
      {} as StudentRepository,
    );
    await expect(service.staffUserIds(tx, ['staff-1'])).resolves.toEqual(['user-1']);
    expect(userIdsOf).toHaveBeenCalledWith(tx, ['staff-1']);
  });
});
