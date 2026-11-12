import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { InstitutionContext, ScopeService } from '../../platform/tenancy/index.js';
import type { TeachingStaff } from '../academic-setup/index.js';
import { StudentClassroomService } from './student-classroom.service.js';
import type { StudentContext } from './student-context.js';
import type { ListStudentsQueryDto } from './student.dto.js';
import type {
  PlacedRow,
  StudentListRow,
  StudentRepository,
  StudentRow,
} from './student.repository.js';

const teacher = {
  personId: 'teacher-1',
  sessionId: 'session-1',
  roleCode: 4,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
} as Principal;

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

const student = {
  id: 'student-1',
  institution_id: 'institution-1',
  status: 1,
  first_name: 'Diya',
  last_name: 'Shetty',
  photo_file_id: 'file-1',
  gender: 2,
  date_of_birth: '2012-03-04',
  blood_group: 'O+',
  admission_no: 'A-17',
  contact_email: 'diya@example.com',
  mobile_number: '9876501234',
  address_line_1: '12 Park Road',
  version: 4,
} as StudentRow;

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

const query = (fields: object = {}) =>
  Object.assign({ page: 1, limit: 20 }, fields) as ListStudentsQueryDto;

function build(found: StudentRow | null = student, placement: PlacedRow | null = placed) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<StudentRepository['find']>().mockResolvedValue(found ?? undefined);
  const placedNow = vi
    .fn<StudentRepository['placedNow']>()
    .mockResolvedValue(placement ?? undefined);
  const page = vi
    .fn<StudentRepository['page']>()
    .mockResolvedValue({ rows: [{ ...student, ...placed } as StudentListRow], total: 1 });
  const ownSectionIds = vi
    .fn<TeachingStaff['ownSectionIds']>()
    .mockImplementation((_tx, _person, institutionId) =>
      Promise.resolve(new Set(institutionId === 'institution-1' ? ['section-1'] : ['section-9'])),
    );
  const requireInstitution = vi
    .fn<ScopeService['requireInstitution']>()
    .mockResolvedValue({ institutionId: 'institution-2' } as InstitutionContext);
  const forPrincipal = vi.fn<ScopeService['forPrincipal']>().mockResolvedValue({
    tenant: { societyId: 'society-1', institutionIds: ['institution-1'] },
  } as unknown as Awaited<ReturnType<ScopeService['forPrincipal']>>);
  const of = vi
    .fn<StudentContext['of']>()
    .mockResolvedValue({ tenant: {}, institutionId: 'institution-1' } as InstitutionContext);
  const service = new StudentClassroomService(
    { transaction } as unknown as DatabaseService,
    { find, placedNow, page } as unknown as StudentRepository,
    { requireInstitution, forPrincipal } as unknown as ScopeService,
    { of } as unknown as StudentContext,
    { ownSectionIds } as unknown as TeachingStaff,
  );
  return { service, find, placedNow, page, ownSectionIds, requireInstitution, of };
}

describe('StudentClassroomService', () => {
  describe('list (STU-01)', () => {
    it('lists the active students of the caller’s own sections, with the classroom fields only', async () => {
      const t = build();
      const result = await t.service.list(teacher, query({ status: [0, 1], q: 'di' }));
      expect(t.page.mock.calls[0]![1]).toMatchObject({
        institutionIds: ['institution-1'],
        statuses: [1],
        inSectionIds: ['section-1'],
        q: 'di',
      });
      expect(result.data).toEqual([
        {
          id: 'student-1',
          institutionId: 'institution-1',
          firstName: 'Diya',
          lastName: 'Shetty',
          photoFileId: 'file-1',
          gender: 2,
          dateOfBirth: '2012-03-04',
          bloodGroup: 'O+',
          placement: {
            academicYearId: 'year-1',
            classId: 'class-1',
            sectionId: 'section-1',
            rollNumber: '14',
          },
        },
      ]);
    });

    it('sorts by name or roll number only, and refuses another field with 400', async () => {
      const t = build();
      await t.service.list(teacher, query({ sort: 'rollNumber' }));
      expect(t.page.mock.calls[0]![2]).toEqual([{ field: 'rollNumber', direction: 'asc' }]);
      expect(await fail(t.service.list(teacher, query({ sort: 'admissionNo' })))).toMatchObject({
        status: 400,
      });
    });

    it('asks for the sections of each Institution it looks in, and only the one named when one is', async () => {
      const t = build();
      await t.service.list(teacher, query({ institutionId: 'institution-2' }));
      expect(t.requireInstitution).toHaveBeenCalledWith(teacher, 'institution-2');
      expect(t.ownSectionIds).toHaveBeenCalledTimes(1);
      expect(t.page.mock.calls[0]![1]).toMatchObject({
        institutionIds: ['institution-2'],
        inSectionIds: ['section-9'],
      });
    });
  });

  describe('get (STU-03)', () => {
    it('shows the classroom view of a student in the caller’s own sections', async () => {
      const t = build();
      const result = await t.service.get(teacher, 'student-1');
      expect(result).toMatchObject({
        id: 'student-1',
        firstName: 'Diya',
        bloodGroup: 'O+',
        placement: { sectionId: 'section-1', rollNumber: '14' },
      });
      expect(Object.keys(result).toSorted()).toEqual([
        'bloodGroup',
        'dateOfBirth',
        'firstName',
        'gender',
        'id',
        'institutionId',
        'lastName',
        'photoFileId',
        'placement',
      ]);
    });

    it('is 403 NOT_ASSIGNED for a student of another section, or one that is deactivated', async () => {
      const other = build(student, { ...placed, section_id: 'section-2' });
      expect(await fail(other.service.get(teacher, 'student-1'))).toEqual({
        status: 403,
        code: 'NOT_ASSIGNED',
      });
      const gone = build({ ...student, status: 0 } as StudentRow, null);
      expect(await fail(gone.service.get(teacher, 'student-1'))).toMatchObject({
        status: 403,
        code: 'NOT_ASSIGNED',
      });
      expect(gone.placedNow).not.toHaveBeenCalled();
    });

    it('is 404 for a student who is not there', async () => {
      expect(await fail(build(null).service.get(teacher, 'student-1'))).toMatchObject({
        status: 404,
      });
    });
  });
});
