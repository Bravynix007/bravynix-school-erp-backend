import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { InstitutionContext } from '../../platform/tenancy/index.js';
import type { PlacementSpan } from '../attendance/index.js';
import { PeopleStudentAttendance } from './people-student-attendance.js';
import type { StudentClassroomService } from './student-classroom.service.js';
import type { StudentContext } from './student-context.js';
import type { StudentRepository, StudentRow } from './student.repository.js';

const tenant: TenantContext = {
  personId: 'person-1',
  roleCode: 3,
  societyId: 'society-1',
  institutionIds: ['inst-1'],
};
const context: InstitutionContext = { institutionId: 'inst-1', societyId: 'society-1', tenant };
const principal = (roleCode: number) => ({ personId: 'person-1', roleCode }) as Principal;
const row = { id: 'student-1' } as StudentRow;
const tx = {} as Tx;

function build(found: StudentRow | null = row) {
  const of = vi.fn<StudentContext['of']>().mockResolvedValue(context);
  const find = vi.fn<StudentRepository['find']>().mockResolvedValue(found ?? undefined);
  const placementSpans = vi.fn<StudentRepository['placementSpans']>().mockResolvedValue([]);
  const ownPlacement = vi.fn<StudentClassroomService['ownPlacement']>();
  const database = {
    transaction: vi.fn<
      (tenant: TenantContext, work: (tx: Tx) => Promise<unknown>) => Promise<unknown>
    >((_tenant, work) => work(tx)),
  };
  const access = new PeopleStudentAttendance(
    database as unknown as DatabaseService,
    { find, placementSpans } as unknown as StudentRepository,
    { of } as unknown as StudentContext,
    { ownPlacement } as unknown as StudentClassroomService,
  );
  return { access, of, find, placementSpans, ownPlacement, database };
}

describe('PeopleStudentAttendance.contextOf', () => {
  it('gives an Owner, an Admin or a parent the context People works out, without a second look', async () => {
    for (const roleCode of [2, 3, 5]) {
      const t = build();
      expect(await t.access.contextOf(principal(roleCode), 'student-1')).toBe(context);
      expect(t.of).toHaveBeenCalledWith(expect.objectContaining({ roleCode }), 'student-1');
      expect(t.ownPlacement).not.toHaveBeenCalled();
      expect(t.database.transaction).not.toHaveBeenCalled();
    }
  });

  it('asks a teacher’s own placement of the student, and passes its refusal on', async () => {
    const t = build();
    const teacher = principal(4);
    expect(await t.access.contextOf(teacher, 'student-1')).toBe(context);
    expect(t.ownPlacement).toHaveBeenCalledWith(tx, teacher, 'inst-1', row);
    t.ownPlacement.mockRejectedValue(AppException.notFound());
    await expect(t.access.contextOf(teacher, 'student-1')).rejects.toBeInstanceOf(AppException);
  });

  it('is 404 for a student a teacher cannot find', async () => {
    const t = build(null);
    await expect(t.access.contextOf(principal(4), 'student-1')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('PeopleStudentAttendance.placementsOf', () => {
  it('reads where the student sat, as the student repository counts it', async () => {
    const t = build();
    const spans: PlacementSpan[] = [];
    t.placementSpans.mockResolvedValue(spans);
    expect(await t.access.placementsOf(tx, 'student-1', '2026-06-01', '2026-11-30')).toBe(spans);
    expect(t.placementSpans).toHaveBeenCalledWith(tx, 'student-1', '2026-06-01', '2026-11-30');
  });
});
