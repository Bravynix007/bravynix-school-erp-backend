import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import {
  audienceGroups,
  checkEventFields,
  checkRange,
  checkScope,
  daysBetween,
  inboxTabOf,
  mayEdit,
  parentsAreTold,
  visibleAudiences,
  type EventFields,
} from './event.rules.js';

const plain: EventFields = {
  startDate: '2026-12-22',
  endDate: '2026-12-24',
  isHoliday: false,
  holidayType: null,
  holidayForStudents: false,
  holidayForStaff: false,
  holidayPredefinedClassIds: [],
};

const holiday: EventFields = {
  ...plain,
  isHoliday: true,
  holidayType: 1,
  holidayForStudents: true,
};

const problemsOf = (work: () => void) => {
  try {
    work();
  } catch (error) {
    if (error instanceof AppException) {
      return (error.options.errors ?? []).map(({ field, code }) => ({ field, code }));
    }
    throw error;
  }
  return [];
};

describe('daysBetween', () => {
  it('counts whole days, across a month end and a leap day', () => {
    expect(daysBetween('2026-12-22', '2026-12-22')).toBe(0);
    expect(daysBetween('2026-12-22', '2027-01-02')).toBe(11);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('checkEventFields', () => {
  it('passes a plain event, a one-day event and a holiday for students, for staff or for both', () => {
    expect(problemsOf(() => checkEventFields(plain))).toEqual([]);
    expect(problemsOf(() => checkEventFields({ ...plain, endDate: plain.startDate }))).toEqual([]);
    expect(problemsOf(() => checkEventFields(holiday))).toEqual([]);
    expect(
      problemsOf(() =>
        checkEventFields({ ...holiday, holidayForStudents: false, holidayForStaff: true }),
      ),
    ).toEqual([]);
    expect(
      problemsOf(() =>
        checkEventFields({
          ...holiday,
          holidayForStaff: true,
          holidayPredefinedClassIds: ['a', 'b'],
        }),
      ),
    ).toEqual([]);
  });

  it('refuses an end before the start', () => {
    expect(problemsOf(() => checkEventFields({ ...plain, endDate: '2026-12-21' }))).toEqual([
      { field: 'endDate', code: 'INVALID_VALUE' },
    ]);
  });

  it('wants a holiday to say its type and who it is for', () => {
    expect(
      problemsOf(() =>
        checkEventFields({ ...holiday, holidayType: null, holidayForStudents: false }),
      ),
    ).toEqual([
      { field: 'holidayType', code: 'REQUIRED' },
      { field: 'holidayForStudents', code: 'REQUIRED' },
    ]);
  });

  it('limits to classes only a holiday for students', () => {
    expect(
      problemsOf(() =>
        checkEventFields({
          ...holiday,
          holidayForStudents: false,
          holidayForStaff: true,
          holidayPredefinedClassIds: ['a'],
        }),
      ),
    ).toEqual([{ field: 'holidayPredefinedClassIds', code: 'FIELD_NOT_ALLOWED' }]);
  });

  it('refuses holiday fields on a plain event, each by name', () => {
    expect(
      problemsOf(() =>
        checkEventFields({
          ...plain,
          holidayType: 2,
          holidayForStudents: true,
          holidayForStaff: true,
          holidayPredefinedClassIds: ['a'],
        }),
      ),
    ).toEqual([
      { field: 'holidayType', code: 'FIELD_NOT_ALLOWED' },
      { field: 'holidayForStudents', code: 'FIELD_NOT_ALLOWED' },
      { field: 'holidayForStaff', code: 'FIELD_NOT_ALLOWED' },
      { field: 'holidayPredefinedClassIds', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });

  it('refuses a class named twice', () => {
    expect(
      problemsOf(() => checkEventFields({ ...holiday, holidayPredefinedClassIds: ['a', 'a'] })),
    ).toEqual([{ field: 'holidayPredefinedClassIds', code: 'INVALID_VALUE' }]);
  });
});

describe('checkScope', () => {
  it('goes with an Institution exactly when it is 2', () => {
    expect(problemsOf(() => checkScope(1, undefined))).toEqual([]);
    expect(problemsOf(() => checkScope(1, null))).toEqual([]);
    expect(problemsOf(() => checkScope(2, 'inst-1'))).toEqual([]);
    expect(problemsOf(() => checkScope(2, undefined))).toEqual([
      { field: 'institutionId', code: 'REQUIRED' },
    ]);
    expect(problemsOf(() => checkScope(1, 'inst-1'))).toEqual([
      { field: 'institutionId', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });
});

describe('checkRange', () => {
  it('takes a span of 366 days, and refuses 367 with RANGE_TOO_LARGE', () => {
    expect(() => checkRange('2026-01-01', '2026-01-01')).not.toThrow();
    expect(() => checkRange('2026-01-01', '2027-01-01')).not.toThrow();
    expect(() => checkRange('2026-01-01', '2027-01-02')).toThrow(
      expect.objectContaining({ code: 'RANGE_TOO_LARGE', status: 400 }) as Error,
    );
  });

  it('counts a leap year as 366 days that fit', () => {
    expect(() => checkRange('2028-01-01', '2028-12-31')).not.toThrow();
  });

  it('refuses an end before the start, on `to`', () => {
    expect(problemsOf(() => checkRange('2026-12-02', '2026-12-01'))).toEqual([
      { field: 'to', code: 'INVALID_VALUE' },
    ]);
  });
});

describe('visibleAudiences', () => {
  it('tells each role about its audiences, and a role with none about nothing', () => {
    expect(visibleAudiences(RoleCode.SocietyOwner)).toEqual([1, 2, 3]);
    expect(visibleAudiences(RoleCode.InstitutionAdmin)).toEqual([1, 2, 3]);
    expect(visibleAudiences(RoleCode.TeacherStaff)).toEqual([1, 3]);
    expect(visibleAudiences(RoleCode.StudentParent)).toEqual([1, 2]);
    expect(visibleAudiences(RoleCode.SuperAdmin)).toEqual([]);
    expect(visibleAudiences(null)).toEqual([]);
  });
});

describe('mayEdit', () => {
  it('lets the Owner change any event, an Admin only an Institution’s, and no one else', () => {
    expect(mayEdit(RoleCode.SocietyOwner, 1)).toBe(true);
    expect(mayEdit(RoleCode.SocietyOwner, 2)).toBe(true);
    expect(mayEdit(RoleCode.InstitutionAdmin, 2)).toBe(true);
    expect(mayEdit(RoleCode.InstitutionAdmin, 1)).toBe(false);
    expect(mayEdit(RoleCode.TeacherStaff, 2)).toBe(false);
    expect(mayEdit(RoleCode.StudentParent, 1)).toBe(false);
    expect(mayEdit(null, 2)).toBe(false);
  });
});

describe('audienceGroups', () => {
  it('makes Everyone of the staff and the parents, and the others of one group', () => {
    expect(audienceGroups(1)).toEqual({ staff: true, parents: true });
    expect(audienceGroups(2)).toEqual({ staff: false, parents: true });
    expect(audienceGroups(3)).toEqual({ staff: true, parents: false });
  });
});

describe('parentsAreTold', () => {
  it('tells the parents of every event and of a holiday for students, and not of a holiday for staff alone', () => {
    expect(parentsAreTold({ isHoliday: false, holidayForStudents: false })).toBe(true);
    expect(parentsAreTold({ isHoliday: true, holidayForStudents: true })).toBe(true);
    expect(parentsAreTold({ isHoliday: true, holidayForStudents: false })).toBe(false);
  });
});

describe('inboxTabOf', () => {
  it('puts Everyone in All, the staff in All teachers and the students and parents in All students', () => {
    expect(inboxTabOf(1)).toBe(2);
    expect(inboxTabOf(3)).toBe(3);
    expect(inboxTabOf(2)).toBe(4);
  });
});
