import type { Tx } from '../../platform/database/index.js';
import { PeopleAttendanceStaff } from './people-attendance-staff.js';
import { PeopleSectionRoster } from './people-section-roster.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';
import type { StudentRepository } from './student.repository.js';

const tx = {} as Tx;

describe('PeopleSectionRoster', () => {
  it('passes the section, the day and the cut-off to the roll, and the enrolments to the lookups', async () => {
    const placedOn = vi.fn<StudentRepository['placedOn']>().mockResolvedValue([]);
    const namedByEnrolment = vi
      .fn<StudentRepository['namedByEnrolment']>()
      .mockResolvedValue(new Map());
    const guardianUsersByEnrolment = vi
      .fn<StudentRepository['guardianUsersByEnrolment']>()
      .mockResolvedValue(new Map());
    const roster = new PeopleSectionRoster({
      placedOn,
      namedByEnrolment,
      guardianUsersByEnrolment,
    } as unknown as StudentRepository);
    const cutOff = new Date('2026-11-17T04:00:00.000Z');
    await roster.on(tx, 'section-1', '2026-11-17', cutOff);
    await roster.studentsOf(tx, ['e1']);
    await roster.guardiansOf(tx, ['e1']);
    expect(placedOn).toHaveBeenCalledWith(tx, 'section-1', '2026-11-17', cutOff);
    expect(namedByEnrolment).toHaveBeenCalledWith(tx, ['e1']);
    expect(guardianUsersByEnrolment).toHaveBeenCalledWith(tx, ['e1']);
  });
});

const buildStaff = (found?: Partial<StaffRow>) =>
  new PeopleAttendanceStaff({
    activeOfUser: vi
      .fn<StaffRepository['activeOfUser']>()
      .mockResolvedValue(found as StaffRow | undefined),
  } as unknown as StaffRepository);

describe('PeopleAttendanceStaff', () => {
  it('says who the caller is and where they are at home', async () => {
    expect(
      await buildStaff({ id: 'staff-1', home_institution_id: 'inst-1' }).ownRecord(tx, 'person-1'),
    ).toEqual({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-1' });
  });

  it('says nothing for a person who is not staff', async () => {
    expect(await buildStaff().ownRecord(tx, 'person-1')).toBeUndefined();
  });
});
