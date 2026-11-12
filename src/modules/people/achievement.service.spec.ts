import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { ScopeService } from '../../platform/tenancy/index.js';
import type { AchievementRepository, AchievementRow } from './achievement.repository.js';
import { AchievementService } from './achievement.service.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';
import type { StudentClassroomService } from './student-classroom.service.js';
import { StudentContext } from './student-context.js';
import type { PlacedRow, StudentRepository, StudentRow } from './student.repository.js';

const as = (roleCode: number, personId: string) =>
  ({ personId, roleCode, societyId: 'society-1' }) as unknown as Principal;
const owner = as(2, 'owner-1');
const admin = as(3, 'admin-1');
const teacher = as(4, 'teacher-1');

const student = (overrides: Partial<StudentRow> = {}): StudentRow =>
  ({
    id: 'student-1',
    society_id: 'society-1',
    institution_id: 'institution-1',
    status: 1,
    ...overrides,
  }) as StudentRow;

const placed: PlacedRow = {
  placement_id: 'placement-1',
  enrolment_id: 'enrolment-1',
  academic_year_id: 'year-1',
  class_id: 'class-1',
  section_id: 'section-1',
  roll_number: '14',
  start_date: '2026-06-01',
  enrolled_date: '2026-06-01',
};

const at = new Date('2026-11-12T05:30:00.000Z');
const star = (overrides: Partial<AchievementRow> = {}): AchievementRow =>
  ({
    id: 'star-1',
    created_at: at,
    created_by: 'teacher-1',
    updated_at: at,
    updated_by: null,
    status: 1,
    society_id: 'society-1',
    institution_id: 'institution-1',
    academic_year_id: 'year-1',
    student_enrolment_id: 'enrolment-1',
    student_id: 'student-1',
    tier: 2,
    description: 'Won the quiz',
    awarded_by_staff_member_id: 'staff-1',
    ...overrides,
  }) as AchievementRow;

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

function build(options: { student?: StudentRow | null; placement?: PlacedRow | null } = {}) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const found = 'student' in options ? options.student : student();
  const studentFind = vi.fn<StudentRepository['find']>().mockResolvedValue(found ?? undefined);
  const openPlacement = vi
    .fn<StudentRepository['openPlacement']>()
    .mockResolvedValue('placement' in options ? (options.placement ?? undefined) : placed);
  const ofStudent = vi.fn<AchievementRepository['ofStudent']>().mockResolvedValue([star()]);
  const find = vi.fn<AchievementRepository['find']>().mockResolvedValue(star());
  const insert = vi
    .fn<AchievementRepository['insert']>()
    .mockImplementation((_tx, values) => Promise.resolve({ ...star(), ...values } as never));
  const remove = vi.fn<AchievementRepository['remove']>().mockResolvedValue();
  const activeOfUser = vi
    .fn<StaffRepository['activeOfUser']>()
    .mockResolvedValue({ id: 'staff-1' } as StaffRow);
  const ownPlacement = vi.fn<StudentClassroomService['ownPlacement']>().mockResolvedValue(placed);
  const requireOwnSection = vi
    .fn<StudentClassroomService['requireOwnSection']>()
    .mockImplementation((_tx, _principal, _institutionId, open) =>
      open ? Promise.resolve(open) : Promise.reject(AppException.forbidden('NOT_ASSIGNED')),
    );
  const describe = vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map());
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue({
    institutionId: 'institution-1',
    societyId: 'society-1',
    tenant: { societyId: 'society-1', institutionIds: ['institution-1'] },
  });
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant: { societyId: 'society-1' } } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const database = { transaction } as unknown as DatabaseService;
  const students = { find: studentFind, openPlacement } as unknown as StudentRepository;
  const scope = { requireInstitution, forPrincipal } as unknown as ScopeService;
  const service = new AchievementService(
    database,
    { ofStudent, find, insert, remove } as unknown as AchievementRepository,
    new StudentContext(database, students, scope),
    students,
    { ownPlacement, requireOwnSection } as unknown as StudentClassroomService,
    { activeOfUser } as unknown as StaffRepository,
    scope,
    { describe } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
  );
  return {
    service,
    studentFind,
    openPlacement,
    ofStudent,
    find,
    insert,
    remove,
    activeOfUser,
    ownPlacement,
    requireOwnSection,
    record,
    requireInstitution,
  };
}

const body = { tier: 2 as const, description: 'Won the quiz' };

describe('AchievementService.list (ACH-01)', () => {
  it('shows the stars earned by tier and the stars, for an admin, with no section check', async () => {
    const t = build();
    const tab = await t.service.list(admin, 'student-1', {});
    expect(tab.stars).toEqual({ total: 1, silver: 0, gold: 1, platinum: 0 });
    expect(tab.achievements).toMatchObject([{ id: 'star-1', studentId: 'student-1', tier: 2 }]);
    expect(t.ofStudent).toHaveBeenCalledWith(expect.anything(), 'student-1', undefined);
    expect(t.ownPlacement).not.toHaveBeenCalled();
  });

  it('passes the year on, and keeps the stars of a deactivated student for an admin', async () => {
    const t = build({ student: student({ status: 0 }) });
    await t.service.list(owner, 'student-1', { academicYearId: 'year-1' });
    expect(t.ofStudent).toHaveBeenCalledWith(expect.anything(), 'student-1', 'year-1');
  });

  it('asks a teacher’s own section first, and gives nothing when it is refused', async () => {
    const t = build();
    await t.service.list(teacher, 'student-1', {});
    expect(t.ownPlacement).toHaveBeenCalledWith(
      expect.anything(),
      teacher,
      'institution-1',
      expect.objectContaining({ id: 'student-1' }),
    );
    t.ownPlacement.mockRejectedValueOnce(AppException.forbidden('NOT_ASSIGNED'));
    expect(await refusal(t.service.list(teacher, 'student-1', {}))).toMatchObject({
      status: 403,
      code: 'NOT_ASSIGNED',
    });
    expect(t.ofStudent).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a student the caller does not reach or that is not there', async () => {
    expect(
      await refusal(build({ student: null }).service.list(admin, 'student-1', {})),
    ).toMatchObject({ status: 404 });
  });
});

describe('AchievementService.add (ACH-02)', () => {
  it('gives the star to the enrolment of the current placement, for the Institution, and audits it', async () => {
    const t = build();
    const created = await t.service.add(admin, 'student-1', body);
    expect(t.studentFind).toHaveBeenCalledWith(expect.anything(), 'student-1', true);
    expect(t.insert.mock.calls[0]![1]).toMatchObject({
      society_id: 'society-1',
      institution_id: 'institution-1',
      academic_year_id: 'year-1',
      student_enrolment_id: 'enrolment-1',
      tier: 2,
      description: 'Won the quiz',
      awarded_by_staff_member_id: 'staff-1',
      created_by: 'admin-1',
    });
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'achievement.created',
      institutionId: 'institution-1',
      entityType: 'student_achievement',
      after: { studentId: 'student-1', academicYearId: 'year-1', tier: 2 },
    });
    expect(created).toMatchObject({ studentId: 'student-1', tier: 2, description: 'Won the quiz' });
  });

  it('records no staff record for an Owner', async () => {
    const t = build();
    await t.service.add(owner, 'student-1', body);
    expect(t.activeOfUser).not.toHaveBeenCalled();
    expect(t.insert.mock.calls[0]![1]).toMatchObject({ awarded_by_staff_member_id: null });
  });

  it('keeps no staff record for an Admin who has none', async () => {
    const t = build();
    t.activeOfUser.mockResolvedValueOnce(undefined);
    await t.service.add(admin, 'student-1', body);
    expect(t.insert.mock.calls[0]![1]).toMatchObject({ awarded_by_staff_member_id: null });
  });

  it('puts a teacher’s star on the open placement when it is in their own section, and refuses one that is not', async () => {
    const t = build();
    await t.service.add(teacher, 'student-1', body);
    expect(t.requireOwnSection).toHaveBeenCalledWith(
      expect.anything(),
      teacher,
      'institution-1',
      placed,
    );
    expect(t.ownPlacement).not.toHaveBeenCalled();
    expect(t.insert.mock.calls[0]![1]).toMatchObject({
      created_by: 'teacher-1',
      awarded_by_staff_member_id: 'staff-1',
      student_enrolment_id: 'enrolment-1',
    });
    const other = build();
    other.requireOwnSection.mockRejectedValueOnce(AppException.forbidden('NOT_ASSIGNED'));
    expect(await refusal(other.service.add(teacher, 'student-1', body))).toMatchObject({
      status: 403,
      code: 'NOT_ASSIGNED',
    });
    expect(other.insert).not.toHaveBeenCalled();
  });

  it('is 422 for a teacher too when the student has no open placement, whatever the latest placement says', async () => {
    const t = build({ placement: null });
    expect(await refusal(t.service.add(teacher, 'student-1', body))).toEqual({
      status: 422,
      code: 'NO_CURRENT_PLACEMENT',
    });
    expect(t.requireOwnSection).not.toHaveBeenCalled();
    expect(t.ownPlacement).not.toHaveBeenCalled();
    expect(t.insert).not.toHaveBeenCalled();
  });

  it('is 422 NO_CURRENT_PLACEMENT for a student who is in no class this year, and 404 for a deactivated one', async () => {
    const none = build({ placement: null });
    expect(await refusal(none.service.add(admin, 'student-1', body))).toEqual({
      status: 422,
      code: 'NO_CURRENT_PLACEMENT',
    });
    expect(none.insert).not.toHaveBeenCalled();
    const gone = build({ student: student({ status: 0 }) });
    expect(await refusal(gone.service.add(admin, 'student-1', body))).toMatchObject({
      status: 404,
    });
    expect(gone.openPlacement).not.toHaveBeenCalled();
  });
});

describe('AchievementService.remove (ACH-03)', () => {
  it('removes the star at its Institution and audits who and what', async () => {
    const t = build();
    expect(await t.service.remove(admin, 'star-1')).toEqual({ id: 'star-1', status: 0 });
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'institution-1');
    expect(t.find).toHaveBeenLastCalledWith(expect.anything(), 'star-1', true);
    expect(t.remove).toHaveBeenCalledWith(expect.anything(), 'star-1', 'admin-1');
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'achievement.removed',
      institutionId: 'institution-1',
      entityType: 'student_achievement',
      entityId: 'star-1',
      before: { studentId: 'student-1', tier: 2, status: 1 },
      after: { status: 0 },
    });
  });

  it('lets a teacher remove a star they gave, and not one another person gave', async () => {
    expect(await build().service.remove(teacher, 'star-1')).toEqual({ id: 'star-1', status: 0 });
    const t = build();
    t.find.mockResolvedValue(star({ created_by: 'teacher-2' }));
    expect(await refusal(t.service.remove(teacher, 'star-1'))).toMatchObject({ status: 403 });
    expect(t.remove).not.toHaveBeenCalled();
    const other = build();
    other.find.mockResolvedValue(star({ created_by: 'admin-1' }));
    expect(await other.service.remove(admin, 'star-1')).toEqual({ id: 'star-1', status: 0 });
  });

  it('is 404 for a star that is not there, is removed already, or is at an Institution the caller does not reach', async () => {
    const none = build();
    none.find.mockResolvedValue(undefined);
    expect(await refusal(none.service.remove(admin, 'star-1'))).toMatchObject({ status: 404 });
    const gone = build();
    gone.find.mockResolvedValueOnce(star()).mockResolvedValueOnce(star({ status: 0 }));
    expect(await refusal(gone.service.remove(admin, 'star-1'))).toMatchObject({ status: 404 });
    const abroad = build();
    abroad.requireInstitution.mockRejectedValue(AppException.notFound());
    expect(await refusal(abroad.service.remove(admin, 'star-1'))).toMatchObject({ status: 404 });
    expect(abroad.remove).not.toHaveBeenCalled();
  });
});
