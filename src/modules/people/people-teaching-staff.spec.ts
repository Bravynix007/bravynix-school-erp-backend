import type { Tx } from '../../platform/database/index.js';
import type { AcademicYearDirectory } from '../academic-setup/index.js';
import type { AssignmentRepository } from './assignment.repository.js';
import { PeopleTeachingStaff } from './people-teaching-staff.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';

const tx = {} as Tx;
const record = { id: 'staff-1' } as StaffRow;

function build(found: StaffRow | null = record, current: string | null = 'year-1') {
  const activeOfUser = vi
    .fn<StaffRepository['activeOfUser']>()
    .mockResolvedValue(found ?? undefined);
  const subjectIds = vi.fn<StaffRepository['subjectIds']>().mockResolvedValue(['subject-1']);
  const activeSectionIds = vi
    .fn<AssignmentRepository['activeSectionIds']>()
    .mockResolvedValue(['section-1', 'section-2']);
  const activeYearIds = vi
    .fn<AssignmentRepository['activeYearIds']>()
    .mockResolvedValue(['year-1']);
  const classTeachersOf = vi
    .fn<AssignmentRepository['classTeachersOf']>()
    .mockResolvedValue([
      { section_id: 'section-1', staff_member_id: 'staff-1', first_name: 'Meera', last_name: null },
    ]);
  const currentId = vi.fn<AcademicYearDirectory['currentId']>().mockResolvedValue(current);
  return {
    staffing: new PeopleTeachingStaff(
      { activeOfUser, subjectIds } as unknown as StaffRepository,
      { activeSectionIds, activeYearIds, classTeachersOf } as unknown as AssignmentRepository,
      { currentId } as unknown as AcademicYearDirectory,
    ),
    activeOfUser,
    subjectIds,
    activeSectionIds,
    activeYearIds,
    classTeachersOf,
    currentId,
  };
}

describe('PeopleTeachingStaff', () => {
  describe('ownSectionIds', () => {
    it('gives the sections of the person’s record in the current year of the Institution', async () => {
      const t = build();
      expect(await t.staffing.ownSectionIds(tx, 'person-1', 'institution-1')).toEqual(
        new Set(['section-1', 'section-2']),
      );
      expect(t.activeOfUser).toHaveBeenCalledWith(tx, 'person-1');
      expect(t.currentId).toHaveBeenCalledWith(tx, 'institution-1');
      expect(t.activeSectionIds).toHaveBeenCalledWith(tx, 'staff-1', 'year-1');
    });

    it('gives nothing without an active staff record, or without a current year', async () => {
      const noRecord = build(null);
      expect((await noRecord.staffing.ownSectionIds(tx, 'person-1', 'institution-1')).size).toBe(0);
      expect(noRecord.activeSectionIds).not.toHaveBeenCalled();
      const noYear = build(record, null);
      expect((await noYear.staffing.ownSectionIds(tx, 'person-1', 'institution-1')).size).toBe(0);
      expect(noYear.activeSectionIds).not.toHaveBeenCalled();
    });
  });

  describe('ownYearIds', () => {
    it('gives the years of the Institution in which the record holds an assignment', async () => {
      const t = build();
      expect(await t.staffing.ownYearIds(tx, 'person-1', 'institution-1')).toEqual(
        new Set(['year-1']),
      );
      expect(t.activeYearIds).toHaveBeenCalledWith(tx, 'staff-1', 'institution-1');
    });

    it('gives nothing without an active staff record', async () => {
      const t = build(null);
      expect((await t.staffing.ownYearIds(tx, 'person-1', 'institution-1')).size).toBe(0);
      expect(t.activeYearIds).not.toHaveBeenCalled();
    });
  });

  describe('ownSubjectIds', () => {
    it('gives the subjects on the record’s own list', async () => {
      const t = build();
      expect(await t.staffing.ownSubjectIds(tx, 'person-1')).toEqual(new Set(['subject-1']));
      expect(t.subjectIds).toHaveBeenCalledWith(tx, 'staff-1');
    });

    it('gives nothing without an active staff record', async () => {
      const t = build(null);
      expect((await t.staffing.ownSubjectIds(tx, 'person-1')).size).toBe(0);
      expect(t.subjectIds).not.toHaveBeenCalled();
    });
  });

  describe('classTeachers', () => {
    it('names the class teacher of each section in the current year', async () => {
      const t = build();
      const result = await t.staffing.classTeachers(tx, 'institution-1', [
        'section-1',
        'section-2',
      ]);
      expect(result).toEqual(
        new Map([['section-1', { staffMemberId: 'staff-1', firstName: 'Meera', lastName: null }]]),
      );
      expect(t.classTeachersOf).toHaveBeenCalledWith(tx, 'year-1', ['section-1', 'section-2']);
    });

    it('names nobody without a current year or without a section', async () => {
      const noYear = build(record, null);
      expect((await noYear.staffing.classTeachers(tx, 'institution-1', ['section-1'])).size).toBe(
        0,
      );
      expect(noYear.classTeachersOf).not.toHaveBeenCalled();
      const none = build();
      expect((await none.staffing.classTeachers(tx, 'institution-1', [])).size).toBe(0);
      expect(none.classTeachersOf).not.toHaveBeenCalled();
    });
  });
});
