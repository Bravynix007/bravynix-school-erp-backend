import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { FileDirectory } from '../../platform/files/index.js';
import type { AccountDirectory, PersonDirectory } from '../../platform/identity/index.js';
import type { MasterReferences } from '../../platform/masters/index.js';
import type { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import type {
  AcademicYearDirectory,
  ClassDirectory,
  SectionDirectory,
} from '../academic-setup/index.js';
import type { StudentClassroomService } from './student-classroom.service.js';
import { StudentContext } from './student-context.js';
import {
  StudentIdentityRepository,
  type StudentIdentityRow,
} from './student-identity.repository.js';
import { StudentIdentityService } from './student-identity.service.js';
import type {
  CreateStudentDto,
  ListStudentsQueryDto,
  MoveStudentDto,
  CorrectStudentClassDto,
  UpdateStudentDto,
} from './student.dto.js';
import type {
  GuardianRow,
  NewGuardian,
  PlacedRow,
  StudentRepository,
  StudentRow,
} from './student.repository.js';
import { StudentService } from './student.service.js';

const owner = {
  personId: 'owner-1',
  sessionId: 'session-1',
  roleCode: 2,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
} as Principal;

const unique = (constraint: string) =>
  Object.assign(new Error('unique'), { code: '23505', constraint });

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) {
      return { status: error.status as number, code: error.code, fields: error.options.errors };
    }
    throw error;
  }
  throw new Error('expected a refusal');
};

const guardianBody = (overrides: object = {}) => ({
  firstName: 'Ravi',
  lastName: 'Shetty',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  email: 'Ravi@Example.com',
  isPrimary: true,
  isEmergencyContact: true,
  ...overrides,
});

const body = (overrides: Partial<CreateStudentDto> = {}): CreateStudentDto =>
  ({
    institutionId: 'institution-1',
    firstName: 'Diya',
    mobile: { countryCode: '91', number: '9876501234' },
    enrolment: {
      academicYearId: 'year-1',
      classId: 'class-1',
      sectionId: 'section-1',
      rollNumber: '14',
    },
    guardians: [guardianBody()],
    ...overrides,
  }) as CreateStudentDto;

const row = (overrides: Partial<StudentRow> = {}): StudentRow =>
  ({
    id: 'student-1',
    created_at: new Date('2026-11-11T00:00:00.000Z'),
    created_by: 'owner-1',
    updated_at: new Date('2026-11-11T00:00:00.000Z'),
    updated_by: 'owner-1',
    version: 1,
    status: 1,
    society_id: 'society-1',
    institution_id: 'institution-1',
    admission_no: null,
    first_name: 'Diya',
    last_name: null,
    country_code: '91',
    mobile_number: '9876501234',
    address_line_1: null,
    address_line_2: null,
    alternate_number: null,
    inactive_reason: null,
    inactive_at: null,
    access_blocked_at: null,
    access_blocked_by: null,
    ...overrides,
  }) as StudentRow;

const placedRow: PlacedRow = {
  placement_id: 'placement-1',
  enrolment_id: 'enrolment-1',
  academic_year_id: 'year-1',
  class_id: 'class-1',
  section_id: 'section-1',
  roll_number: '14',
  start_date: '2026-11-11',
  enrolled_date: '2026-11-11',
};

function build(found: StudentRow | null = row()) {
  const tx = {} as Tx;
  const order: string[] = [];
  const transaction = vi.fn<DatabaseService['transaction']>(async (_tenant, work) => {
    const result = await work(tx);
    order.push('commit');
    return result;
  });
  const find = vi.fn<StudentRepository['find']>().mockResolvedValue(found ?? undefined);
  const insert = vi
    .fn<StudentRepository['insert']>()
    .mockImplementation((_tx, values) => Promise.resolve(row(values as Partial<StudentRow>)));
  const insertEnrolment = vi
    .fn<StudentRepository['insertEnrolment']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve({ id: 'enrolment-1', ...values } as Awaited<
        ReturnType<StudentRepository['insertEnrolment']>
      >),
    );
  const insertPlacement = vi
    .fn<StudentRepository['insertPlacement']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve({ id: 'placement-1', ...values } as Awaited<
        ReturnType<StudentRepository['insertPlacement']>
      >),
    );
  const insertGuardians = vi
    .fn<StudentRepository['insertGuardians']>()
    .mockImplementation((_tx, rows: NewGuardian[]) =>
      Promise.resolve(
        rows.map((values, index) => ({ id: `guardian-${index}`, ...values }) as GuardianRow),
      ),
    );
  const guardians = vi.fn<StudentRepository['guardians']>().mockResolvedValue([]);
  const update = vi
    .fn<StudentRepository['update']>()
    .mockImplementation((_tx, _id, changes) =>
      Promise.resolve(row({ ...(changes as Partial<StudentRow>), version: 2 })),
    );
  const openPlacement = vi.fn<StudentRepository['openPlacement']>().mockResolvedValue(placedRow);
  const updatePlacement = vi
    .fn<StudentRepository['updatePlacement']>()
    .mockResolvedValue(undefined);
  const updateEnrolment = vi
    .fn<StudentRepository['updateEnrolment']>()
    .mockResolvedValue(undefined);
  const deferPlacementClassKey = vi
    .fn<StudentRepository['deferPlacementClassKey']>()
    .mockResolvedValue(undefined);
  const otherPlacements = vi.fn<StudentRepository['otherPlacements']>().mockResolvedValue([]);
  const updateOtherPlacements = vi
    .fn<StudentRepository['updateOtherPlacements']>()
    .mockResolvedValue(undefined);
  const previousEnrolment = vi
    .fn<StudentRepository['previousEnrolment']>()
    .mockResolvedValue(undefined);
  const isBelow = vi.fn<ClassDirectory['isBelow']>().mockResolvedValue(false);
  const placedNow = vi.fn<StudentRepository['placedNow']>().mockResolvedValue(placedRow);
  const sectionCount = vi.fn<StudentRepository['sectionCount']>().mockResolvedValue(1);
  const page = vi
    .fn<StudentRepository['page']>()
    .mockResolvedValue({ rows: [{ ...row(), ...placedRow }], total: 41 });
  const identityFind = vi.fn<StudentIdentityRepository['find']>().mockResolvedValue(undefined);
  const seal = vi.fn<StudentIdentityService['seal']>().mockReturnValue(undefined);
  const writeIdentity = vi
    .fn<StudentIdentityService['write']>()
    .mockResolvedValue({ row: undefined, elsewhere: false });
  const requirePlace = vi.fn<MasterReferences['requirePlace']>().mockResolvedValue(undefined);
  const requireReady = vi.fn<FileDirectory['requireReady']>().mockResolvedValue(undefined);
  const openYear = vi.fn<AcademicYearDirectory['openYear']>().mockResolvedValue({
    open: true,
    startDate: '2026-06-01',
    endDate: '2027-03-31',
  });
  const placeOf = vi.fn<SectionDirectory['placeOf']>().mockResolvedValue({
    classId: 'class-1',
    institutionId: 'institution-1',
    active: true,
    capacity: null,
  });
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue({
    institutionId: 'institution-1',
    societyId: 'society-1',
    tenant: { societyId: 'society-1', institutionIds: ['institution-1'] },
  });
  const forPrincipal = vi.fn<ScopeService['forPrincipal']>().mockResolvedValue({
    tenant: { societyId: 'society-1', institutionIds: ['institution-1', 'institution-2'] },
  } as unknown as Awaited<ReturnType<ScopeService['forPrincipal']>>);
  const linkGuardian = vi.fn<AccountDirectory['linkGuardian']>().mockImplementation((_tx, person) =>
    Promise.resolve({
      id: `user-${person.email}`,
      email: person.email.toLowerCase(),
      displayName: person.firstName ?? '',
      created: true,
    }),
  );
  const welcomeAs = vi.fn<AccountDirectory['welcomeAs']>(() => {
    order.push('welcome');
  });
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const database = { transaction } as unknown as DatabaseService;
  const repository = {
    find,
    insert,
    insertEnrolment,
    insertPlacement,
    insertGuardians,
    guardians,
    update,
    openPlacement,
    updatePlacement,
    updateEnrolment,
    deferPlacementClassKey,
    otherPlacements,
    updateOtherPlacements,
    previousEnrolment,
    placedNow,
    sectionCount,
    page,
  } as unknown as StudentRepository;
  const scopeService = { requireInstitution, forPrincipal } as unknown as ScopeService;
  const classroomList = vi
    .fn<StudentClassroomService['list']>()
    .mockResolvedValue(ApiResult.list([], null));
  const classroomGet = vi
    .fn<StudentClassroomService['get']>()
    .mockResolvedValue({ id: 'student-1' } as Awaited<ReturnType<StudentClassroomService['get']>>);
  const service = new StudentService(
    database,
    repository,
    scopeService,
    new StudentContext(database, repository, scopeService),
    { linkGuardian, welcomeAs } as unknown as AccountDirectory,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { requirePlace } as unknown as MasterReferences,
    { requireReady } as unknown as FileDirectory,
    { openYear } as unknown as AcademicYearDirectory,
    { placeOf } as unknown as SectionDirectory,
    { isBelow } as unknown as ClassDirectory,
    {
      names: vi.fn<InstitutionDirectory['names']>().mockResolvedValue(
        new Map([
          [
            'institution-1',
            {
              id: 'institution-1',
              name: 'School',
              societyId: 'society-1',
              societyName: 'Sunrise Trust',
            },
          ],
        ]),
      ),
    } as unknown as InstitutionDirectory,
    { record } as unknown as AuditService,
    new FixedClock('2026-11-11T04:30:00.000Z'),
    { list: classroomList, get: classroomGet } as unknown as StudentClassroomService,
    { find: identityFind } as unknown as StudentIdentityRepository,
    { seal, write: writeIdentity } as unknown as StudentIdentityService,
  );
  return {
    service,
    order,
    transaction,
    find,
    insert,
    insertEnrolment,
    insertPlacement,
    insertGuardians,
    guardians,
    update,
    openPlacement,
    updatePlacement,
    updateEnrolment,
    deferPlacementClassKey,
    otherPlacements,
    updateOtherPlacements,
    previousEnrolment,
    isBelow,
    placedNow,
    sectionCount,
    page,
    identityFind,
    seal,
    writeIdentity,
    requirePlace,
    requireReady,
    openYear,
    placeOf,
    requireInstitution,
    forPrincipal,
    classroomList,
    classroomGet,
    linkGuardian,
    welcomeAs,
    record,
  };
}

const query = (fields: object = {}) =>
  Object.assign({ page: 2, limit: 20 }, fields) as ListStudentsQueryDto;

const move = (fields: object = {}) => fields as MoveStudentDto;
const correct = (fields: object = {}) =>
  ({ classId: 'class-2', sectionId: 'section-9', ...fields }) as CorrectStudentClassDto;
const openAt = (start: string): PlacedRow => ({ ...placedRow, start_date: start });

const change = (fields: object = {}) => ({ version: 1, ...fields }) as UpdateStudentDto;

/** The section the student is corrected into belongs to the second class. */
const inClass2 = (t: ReturnType<typeof build>, capacity: number | null = null) =>
  t.placeOf.mockResolvedValue({
    classId: 'class-2',
    institutionId: 'institution-1',
    active: true,
    capacity,
  });

describe('StudentService', () => {
  describe('create (STU-02)', () => {
    it('adds the student, the enrolment, the placement and the guardians at the Institution, audits it, and mails the welcome after the commit', async () => {
      const t = build();
      const created = await t.service.create(
        owner,
        body({ admissionNo: 'GVS-1', contactEmail: 'Diya@Example.com' }),
      );
      expect(t.requireInstitution).toHaveBeenCalledWith(owner, 'institution-1');
      const base = {
        society_id: 'society-1',
        institution_id: 'institution-1',
        created_by: 'owner-1',
      };
      expect(t.insert.mock.calls[0]![1]).toMatchObject({
        ...base,
        admission_no: 'GVS-1',
        first_name: 'Diya',
        contact_email: 'diya@example.com',
        country_code: '91',
        mobile_number: '9876501234',
      });
      const studentId = t.insert.mock.calls[0]![1].id;
      expect(t.insertEnrolment.mock.calls[0]![1]).toMatchObject({
        ...base,
        student_id: studentId,
        academic_year_id: 'year-1',
        class_id: 'class-1',
        enrolled_date: '2026-11-11',
      });
      expect(t.insertPlacement.mock.calls[0]![1]).toMatchObject({
        ...base,
        student_enrolment_id: 'enrolment-1',
        academic_year_id: 'year-1',
        class_id: 'class-1',
        section_id: 'section-1',
        roll_number: '14',
        start_date: '2026-11-11',
      });
      expect(t.insertGuardians.mock.calls[0]![1]).toEqual([
        expect.objectContaining({
          ...base,
          student_id: studentId,
          user_id: 'user-Ravi@Example.com',
          email: 'ravi@example.com',
          first_name: 'Ravi',
          relation: 1,
          phone_number: '9845012345',
          is_primary: true,
          is_emergency_contact: true,
        }),
      ]);
      expect(t.linkGuardian.mock.calls[0]).toMatchObject([
        expect.anything(),
        { email: 'Ravi@Example.com', firstName: 'Ravi', lastName: 'Shetty' },
        'owner-1',
      ]);
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'student.created',
        institutionId: 'institution-1',
        entityType: 'student',
        entityId: studentId,
      });
      expect(t.welcomeAs).toHaveBeenCalledWith({ email: 'ravi@example.com' }, 5, 'Sunrise Trust');
      expect(t.order).toEqual(['commit', 'welcome']);
      expect(created.options).toMatchObject({ status: 201, code: 'CREATED', meta: null });
      expect(created.data).toMatchObject({ firstName: 'Diya', guardians: [expect.anything()] });
    });

    it('starts the class and the section on the admission date, and keeps a guardian without an email loginless and unmailed', async () => {
      const t = build();
      await t.service.create(
        owner,
        body({
          admissionDate: '2026-06-01',
          guardians: [
            guardianBody({ email: undefined }),
            guardianBody({ isPrimary: false, email: null }),
          ],
        }),
      );
      expect(t.insertEnrolment.mock.calls[0]![1].enrolled_date).toBe('2026-06-01');
      expect(t.insertPlacement.mock.calls[0]![1].start_date).toBe('2026-06-01');
      expect(t.linkGuardian).not.toHaveBeenCalled();
      expect(t.insertGuardians.mock.calls[0]![1]).toEqual([
        expect.objectContaining({ user_id: null, email: null }),
        expect.objectContaining({ user_id: null, email: null }),
      ]);
      expect(t.welcomeAs).not.toHaveBeenCalled();
    });

    it('mails every guardian who has an email, once each', async () => {
      const t = build();
      await t.service.create(
        owner,
        body({
          guardians: [
            guardianBody(),
            guardianBody({ isPrimary: false, email: 'lata@example.com' }),
            guardianBody({ isPrimary: false, email: undefined }),
          ],
        }),
      );
      expect(t.welcomeAs.mock.calls.map(([person]) => person.email)).toEqual([
        'ravi@example.com',
        'lata@example.com',
      ]);
    });

    it('refuses the body before it opens a transaction: no primary guardian, a future birth', async () => {
      const t = build();
      expect(
        await fail(
          t.service.create(owner, body({ guardians: [guardianBody({ isPrimary: false })] })),
        ),
      ).toMatchObject({
        status: 422,
        code: 'PRIMARY_GUARDIAN_REQUIRED',
      });
      expect(
        await fail(t.service.create(owner, body({ dateOfBirth: '2026-11-11' }))),
      ).toMatchObject({
        status: 400,
      });
      expect(t.transaction).not.toHaveBeenCalled();
    });

    it('checks the photo and the place, and only when they are sent', async () => {
      const t = build();
      await t.service.create(owner, body());
      expect(t.requireReady).not.toHaveBeenCalled();
      expect(t.requirePlace).not.toHaveBeenCalled();
      await t.service.create(
        owner,
        body({ photoFileId: 'photo-1', address: { countryId: 'country-1' } }),
      );
      expect(t.requireReady.mock.calls[0]).toMatchObject([
        expect.anything(),
        'photo-1',
        { purpose: 3, institutionId: 'institution-1' },
        'photoFileId',
      ]);
      expect(t.requirePlace.mock.calls[0]![2]).toBe('address');
    });

    it('is 404 for a year or section that is not this Institution’s, before any account is made', async () => {
      const t = build();
      t.openYear.mockResolvedValueOnce(undefined);
      expect((await fail(t.service.create(owner, body()))).status).toBe(404);
      t.placeOf.mockResolvedValueOnce(undefined);
      expect((await fail(t.service.create(owner, body()))).status).toBe(404);
      t.placeOf.mockResolvedValueOnce({
        classId: 'class-1',
        institutionId: 'institution-2',
        active: true,
        capacity: null,
      });
      expect((await fail(t.service.create(owner, body()))).status).toBe(404);
      expect(t.linkGuardian).not.toHaveBeenCalled();
      expect(t.welcomeAs).not.toHaveBeenCalled();
    });

    it('is 422 for a year that is closed, a section of another class and a section that is closed, in that order', async () => {
      const t = build();
      t.openYear.mockResolvedValueOnce({
        open: false,
        startDate: '2026-06-01',
        endDate: '2027-03-31',
      });
      expect(await fail(t.service.create(owner, body()))).toMatchObject({
        status: 422,
        code: 'YEAR_NOT_ACTIVE',
      });
      t.placeOf.mockResolvedValueOnce({
        classId: 'class-2',
        institutionId: 'institution-1',
        active: false,
        capacity: null,
      });
      expect(await fail(t.service.create(owner, body()))).toMatchObject({
        status: 422,
        code: 'SECTION_NOT_IN_CLASS',
      });
      t.placeOf.mockResolvedValueOnce({
        classId: 'class-1',
        institutionId: 'institution-1',
        active: false,
        capacity: null,
      });
      expect(await fail(t.service.create(owner, body()))).toMatchObject({
        status: 422,
        code: 'INACTIVE_SECTION',
      });
      expect(t.linkGuardian).not.toHaveBeenCalled();
      expect(t.insert).not.toHaveBeenCalled();
    });

    it.each([
      [1, null],
      [2, { warnings: ['SECTION_OVER_CAPACITY'] }],
    ])(
      'with a capacity of 1 and %s students in the section after the add, answers meta %j',
      async (held, meta) => {
        const t = build();
        t.placeOf.mockResolvedValue({
          classId: 'class-1',
          institutionId: 'institution-1',
          active: true,
          capacity: 1,
        });
        t.sectionCount.mockResolvedValue(held);
        const created = await t.service.create(owner, body());
        expect(t.sectionCount.mock.calls[0]!.slice(1)).toEqual(['year-1', 'section-1']);
        expect(created.options.meta).toEqual(meta);
      },
    );

    it('does not count a section without a capacity', async () => {
      const t = build();
      const created = await t.service.create(owner, body());
      expect(t.sectionCount).not.toHaveBeenCalled();
      expect(created.options.meta).toBeNull();
    });

    describe('with an identity', () => {
      const sealed = {
        ciphertext: Buffer.from('sealed'),
        keyVersion: 1,
        hmac: Buffer.alloc(32, 7),
        last4: '9012',
      };
      const stored = {
        aadhaar_last4: '9012',
        birth_certificate_number: 'BC-1',
      } as StudentIdentityRow;

      it('seals the number for the new student before anything is written, writes both numbers in the same transaction and shows them masked', async () => {
        const t = build();
        t.seal.mockReturnValue(sealed);
        t.writeIdentity.mockResolvedValue({ row: stored, elsewhere: false });
        const identity = { aadhaarNumber: '2345 6789 9012', birthCertificateNumber: 'BC-1' };
        const created = await t.service.create(owner, body({ identity }));
        const studentId = t.insert.mock.calls[0]![1].id;
        expect(t.seal).toHaveBeenCalledWith(studentId, identity);
        expect(t.seal.mock.invocationCallOrder[0]).toBeLessThan(
          t.transaction.mock.invocationCallOrder[0]!,
        );
        expect(t.writeIdentity).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ id: studentId }),
          sealed,
          'BC-1',
          'owner-1',
        );
        expect(created.data).toMatchObject({
          identity: { aadhaarMasked: 'XXXX XXXX 9012', birthCertificateNumber: 'BC-1' },
        });
        expect(created.options.meta).toBeNull();
      });

      it('writes nothing about an identity that is not sent, and shows none', async () => {
        const t = build();
        const created = await t.service.create(owner, body());
        expect(t.seal).toHaveBeenCalledWith(expect.any(String), undefined);
        expect(created.data).toMatchObject({
          identity: { aadhaarMasked: null, birthCertificateNumber: null },
        });
      });

      it.each([
        [false, null],
        [true, { warnings: ['AADHAAR_EXISTS_IN_SOCIETY'] }],
      ])(
        'with a number held at another Institution of the Society (%s) answers meta %j',
        async (elsewhere, meta) => {
          const t = build();
          t.writeIdentity.mockResolvedValue({ row: stored, elsewhere });
          const created = await t.service.create(owner, body());
          expect(created.options.meta).toEqual(meta);
        },
      );

      it('lists both warnings when the section is over its capacity too', async () => {
        const t = build();
        t.placeOf.mockResolvedValue({
          classId: 'class-1',
          institutionId: 'institution-1',
          active: true,
          capacity: 1,
        });
        t.sectionCount.mockResolvedValue(2);
        t.writeIdentity.mockResolvedValue({ row: stored, elsewhere: true });
        const created = await t.service.create(owner, body());
        expect(created.options.meta).toEqual({
          warnings: ['SECTION_OVER_CAPACITY', 'AADHAAR_EXISTS_IN_SOCIETY'],
        });
      });

      it('is 422 for a number that is not an Aadhaar number before a transaction opens, and mails nobody', async () => {
        const t = build();
        t.seal.mockImplementation(() => {
          throw new AppException(422, 'INVALID_AADHAAR');
        });
        expect(
          await fail(t.service.create(owner, body({ identity: { aadhaarNumber: '123' } }))),
        ).toMatchObject({ status: 422, code: 'INVALID_AADHAAR' });
        expect(t.transaction).not.toHaveBeenCalled();
        expect(t.order).not.toContain('welcome');
      });

      it('is 409 when another student of the Institution holds the number, and mails nobody', async () => {
        const t = build();
        t.writeIdentity.mockRejectedValue(
          AppException.conflict(ErrorCode.AADHAAR_DUPLICATE_IN_INSTITUTION),
        );
        expect(await fail(t.service.create(owner, body()))).toMatchObject({
          status: 409,
          code: 'AADHAAR_DUPLICATE_IN_INSTITUTION',
        });
        expect(t.order).not.toContain('welcome');
      });
    });

    it('says which number is taken: the Admission ID, the roll number', async () => {
      const t = build();
      t.insert.mockRejectedValueOnce(unique('uq_students_institution_admission_no'));
      expect(await fail(t.service.create(owner, body({ admissionNo: 'GVS-1' })))).toMatchObject({
        status: 409,
        code: 'ADMISSION_NO_TAKEN',
      });
      t.insertPlacement.mockRejectedValueOnce(unique('uq_placements_roll'));
      expect(await fail(t.service.create(owner, body()))).toMatchObject({
        status: 409,
        code: 'ROLL_NUMBER_TAKEN',
      });
      expect(t.welcomeAs).not.toHaveBeenCalled();
    });

    it('says the photo is already a child’s on the field, and lets any other error through', async () => {
      const t = build();
      t.insert.mockRejectedValueOnce(unique('uq_students_photo'));
      expect(await fail(t.service.create(owner, body({ photoFileId: 'photo-1' })))).toMatchObject({
        status: 400,
        fields: [expect.objectContaining({ field: 'photoFileId', code: 'INVALID_VALUE' })],
      });
      const broken = new Error('connection lost');
      t.insert.mockRejectedValueOnce(broken);
      await expect(t.service.create(owner, body())).rejects.toBe(broken);
    });

    it('passes a refusal to link a guardian on, and mails nobody', async () => {
      const t = build();
      t.linkGuardian.mockRejectedValueOnce(AppException.conflict('ACCOUNT_BLOCKED'));
      expect(await fail(t.service.create(owner, body()))).toMatchObject({
        status: 409,
        code: 'ACCOUNT_BLOCKED',
      });
      expect(t.welcomeAs).not.toHaveBeenCalled();
    });
  });

  describe('list (STU-01)', () => {
    it('lists the Institutions the caller reaches, a page at a time, active students by name', async () => {
      const t = build();
      const result = await t.service.list(owner, query());
      expect(t.page.mock.calls[0]).toMatchObject([
        expect.anything(),
        { institutionIds: ['institution-1', 'institution-2'], statuses: [1] },
        [{ field: 'name', direction: 'asc' }],
        20,
        20,
      ]);
      expect(result.options.meta).toEqual({ page: 2, limit: 20, totalItems: 41, totalPages: 3 });
      expect(result.data[0]).toMatchObject({ id: 'student-1', placement: { rollNumber: '14' } });
    });

    it('narrows to the Institution named, once the caller is known to reach it, and passes the filters on', async () => {
      const t = build();
      await t.service.list(
        owner,
        query({
          institutionId: 'institution-1',
          q: 'di',
          academicYearId: 'year-1',
          classId: 'class-1',
          sectionId: 'section-1',
          status: [0, 1],
          sort: '-rollNumber',
        }),
      );
      expect(t.requireInstitution).toHaveBeenCalledWith(owner, 'institution-1');
      expect(t.page.mock.calls[0]).toMatchObject([
        expect.anything(),
        {
          q: 'di',
          institutionIds: ['institution-1'],
          statuses: [0, 1],
          academicYearId: 'year-1',
          classId: 'class-1',
          sectionId: 'section-1',
        },
        [{ field: 'rollNumber', direction: 'desc' }],
        20,
        20,
      ]);
    });

    it('is 404 for an Institution the caller does not reach', async () => {
      const t = build();
      t.requireInstitution.mockRejectedValueOnce(AppException.notFound());
      expect(
        (await fail(t.service.list(owner, query({ institutionId: 'institution-9' })))).status,
      ).toBe(404);
      expect(t.page).not.toHaveBeenCalled();
    });

    it('reads no Institution for a caller with none', async () => {
      const t = build();
      t.forPrincipal.mockResolvedValueOnce({ tenant: { societyId: 'society-1' } } as Awaited<
        ReturnType<ScopeService['forPrincipal']>
      >);
      await t.service.list(owner, query());
      expect(t.page.mock.calls[0]![1].institutionIds).toEqual([]);
    });
  });

  describe('the classroom view for a Teacher or Staff member (STU-01, STU-03)', () => {
    const teacher = { ...owner, personId: 'teacher-1', roleCode: 4 } as Principal;

    it('hands the list to the classroom view, and reads nothing as an admin would', async () => {
      const t = build();
      await t.service.list(teacher, query());
      expect(t.classroomList).toHaveBeenCalledWith(teacher, query());
      expect(t.page).not.toHaveBeenCalled();
    });

    it('hands the profile to the classroom view too', async () => {
      const t = build();
      expect(await t.service.get(teacher, 'student-1')).toEqual({ id: 'student-1' });
      expect(t.classroomGet).toHaveBeenCalledWith(teacher, 'student-1');
      expect(t.guardians).not.toHaveBeenCalled();
    });

    it('does not use it for an admin', async () => {
      const t = build();
      await t.service.list(owner, query());
      await t.service.get(owner, 'student-1');
      expect(t.classroomList).not.toHaveBeenCalled();
      expect(t.classroomGet).not.toHaveBeenCalled();
    });
  });

  describe('get (STU-03)', () => {
    it('opens the Institution of the student, then reads the record, where it sits and the guardians', async () => {
      const t = build();
      const student = await t.service.get(owner, 'student-1');
      expect(t.requireInstitution).toHaveBeenCalledWith(owner, 'institution-1');
      expect(t.placedNow).toHaveBeenCalledWith(expect.anything(), 'student-1');
      expect(t.guardians).toHaveBeenCalledWith(expect.anything(), 'student-1');
      expect(student).toMatchObject({
        id: 'student-1',
        placement: { sectionId: 'section-1' },
        guardians: [],
      });
    });

    it('shows the identity masked: the Aadhaar number by its last four digits, never whole', async () => {
      const t = build();
      t.identityFind.mockResolvedValue({
        aadhaar_last4: '9012',
        aadhaar_ciphertext: Buffer.from('sealed'),
        birth_certificate_number: null,
      } as StudentIdentityRow);
      const student = await t.service.get(owner, 'student-1');
      expect(t.identityFind).toHaveBeenCalledWith(expect.anything(), 'student-1');
      expect(student).toMatchObject({
        identity: { aadhaarMasked: 'XXXX XXXX 9012', birthCertificateNumber: null },
      });
      expect(JSON.stringify(student)).not.toContain('sealed');
    });

    it('is 404 for a student who is not there, and for an Institution the caller does not reach', async () => {
      const t = build(null);
      expect((await fail(t.service.get(owner, 'student-1'))).status).toBe(404);
      const u = build();
      u.requireInstitution.mockRejectedValueOnce(AppException.notFound());
      expect((await fail(u.service.get(owner, 'student-1'))).status).toBe(404);
    });
  });

  describe('update (STU-04)', () => {
    it('writes only what changed, stamps the author, and audits the before and after', async () => {
      const t = build(row({ last_name: 'Shetty', nationality: 'Indian' }));
      const student = await t.service.update(
        owner,
        'student-1',
        change({
          firstName: 'Diya',
          lastName: 'Rao',
          nationality: 'Indian',
          contactEmail: 'Diya@Example.com',
          mobile: { countryCode: '91', number: '9000000001' },
          address: { line1: '12 Lake Road' },
        }),
      );
      expect(t.update).toHaveBeenCalledWith(expect.anything(), 'student-1', {
        last_name: 'Rao',
        contact_email: 'diya@example.com',
        mobile_number: '9000000001',
        address_line_1: '12 Lake Road',
        updated_by: 'owner-1',
      });
      expect(student.version).toBe(2);
      expect(t.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'student.updated',
          institutionId: 'institution-1',
          entityType: 'student',
          entityId: 'student-1',
          before: expect.objectContaining({ lastName: 'Shetty' }),
          after: expect.objectContaining({ lastName: 'Rao' }),
        }),
      );
    });

    it('clears an optional field with null, and the email with it', async () => {
      const t = build(row({ last_name: 'Shetty', contact_email: 'a@example.com' }));
      await t.service.update(owner, 'student-1', change({ lastName: null, contactEmail: null }));
      expect(t.update.mock.calls[0]![2]).toMatchObject({ last_name: null, contact_email: null });
    });

    it('clears the whole address with null, and leaves it alone when it is not sent', async () => {
      const t = build(
        row({
          address_line_1: '12 Lake Road',
          address_line_2: null,
          country_id: null,
          state_id: null,
          pincode: '560001',
          city_id: 'city-1',
        }),
      );
      await t.service.update(owner, 'student-1', change({ address: null }));
      expect(t.update.mock.calls[0]![2]).toEqual({
        address_line_1: null,
        pincode: null,
        city_id: null,
        updated_by: 'owner-1',
      });
      const untouched = build(row({ address_line_1: '12 Lake Road' }));
      await untouched.service.update(owner, 'student-1', change({ firstName: 'Diya' }));
      expect(untouched.update).not.toHaveBeenCalled();
    });

    it('refuses an admission date after the day the child started in their class, as the add does', async () => {
      const t = build();
      t.placedNow.mockResolvedValue({ ...placedRow, enrolled_date: '2026-06-01' });
      const refused = await fail(
        t.service.update(owner, 'student-1', change({ admissionDate: '2026-06-02' })),
      );
      expect(refused.status).toBe(400);
      expect(refused.fields).toEqual([expect.objectContaining({ field: 'admissionDate' })]);
      expect(t.update).not.toHaveBeenCalled();
      const fine = build();
      fine.placedNow.mockResolvedValue({ ...placedRow, enrolled_date: '2026-06-01' });
      await fine.service.update(owner, 'student-1', change({ admissionDate: '2026-06-01' }));
      expect(fine.update.mock.calls[0]![2]).toMatchObject({ admission_date: '2026-06-01' });
    });

    it('writes nothing for a request that changes nothing, and still answers with the profile', async () => {
      const t = build();
      const student = await t.service.update(owner, 'student-1', change({ firstName: 'Diya' }));
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
      expect(student).toMatchObject({ id: 'student-1', version: 1 });
    });

    it('is 409 for a stale version before anything else is looked at', async () => {
      const t = build(row({ version: 3 }));
      const refused = await fail(
        t.service.update(owner, 'student-1', change({ dateOfBirth: '2999-01-01' })),
      );
      expect(refused.status).toBe(409);
      expect(refused.code).toBe('VERSION_CONFLICT');
    });

    it('is 404 for a deactivated student, and for an Institution the caller does not reach', async () => {
      const t = build(row({ status: 0 }));
      expect((await fail(t.service.update(owner, 'student-1', change()))).status).toBe(404);
      const u = build();
      u.requireInstitution.mockRejectedValueOnce(AppException.notFound());
      expect((await fail(u.service.update(owner, 'student-1', change()))).status).toBe(404);
    });

    it('checks the dates as they will stand: a date not sent keeps its stored value', async () => {
      const t = build(row({ date_of_birth: '2014-03-09' }));
      const refused = await fail(
        t.service.update(owner, 'student-1', change({ admissionDate: '2010-01-01' })),
      );
      expect(refused.status).toBe(400);
      expect(refused.fields).toEqual([expect.objectContaining({ field: 'admissionDate' })]);
      expect(t.update).not.toHaveBeenCalled();
    });

    it('looks at a place and a photo only when they change', async () => {
      const t = build(row({ country_id: 'country-1', state_id: 'state-1' }));
      await t.service.update(owner, 'student-1', change({ address: { countryId: 'country-1' } }));
      expect(t.requirePlace).not.toHaveBeenCalled();
      expect(t.requireReady).not.toHaveBeenCalled();
      await t.service.update(
        owner,
        'student-1',
        change({ address: { cityId: 'city-1' }, photoFileId: 'file-1' }),
      );
      expect(t.requirePlace).toHaveBeenCalledWith(
        expect.anything(),
        { countryId: 'country-1', stateId: 'state-1', cityId: 'city-1' },
        'address',
        { countryId: 'country-1', stateId: 'state-1' },
      );
      expect(t.requireReady).toHaveBeenCalledWith(
        expect.anything(),
        'file-1',
        expect.objectContaining({ institutionId: 'institution-1' }),
        'photoFileId',
      );
    });

    it('answers a taken Admission ID, and a photo another child holds, in the words of the API', async () => {
      const t = build();
      t.update.mockRejectedValueOnce(unique('uq_students_institution_admission_no'));
      expect(
        (await fail(t.service.update(owner, 'student-1', change({ admissionNo: 'GVS-1' })))).code,
      ).toBe('ADMISSION_NO_TAKEN');
      t.update.mockRejectedValueOnce(unique('uq_students_photo'));
      const refused = await fail(
        t.service.update(owner, 'student-1', change({ photoFileId: 'file-1' })),
      );
      expect(refused.status).toBe(400);
      expect(refused.fields).toEqual([expect.objectContaining({ field: 'photoFileId' })]);
    });
  });

  describe('deactivate (STU-05)', () => {
    it('ends the placement today, ends the enrolment as left, and records why', async () => {
      const t = build();
      expect(await t.service.deactivate(owner, 'student-1', { reason: 1 })).toEqual({
        id: 'student-1',
        status: 0,
      });
      expect(t.updatePlacement).toHaveBeenCalledWith(expect.anything(), 'placement-1', {
        end_date: '2026-11-11',
        updated_by: 'owner-1',
      });
      expect(t.updateEnrolment).toHaveBeenCalledWith(expect.anything(), 'enrolment-1', {
        left_date: '2026-11-11',
        outcome: 3,
        updated_by: 'owner-1',
      });
      expect(t.update).toHaveBeenCalledWith(expect.anything(), 'student-1', {
        status: 0,
        inactive_reason: 1,
        inactive_at: new Date('2026-11-11T04:30:00.000Z'),
        updated_by: 'owner-1',
      });
      expect(t.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'student.deactivated',
          before: expect.objectContaining({ status: 1, inactiveReason: null }),
          after: expect.objectContaining({ status: 0, inactiveReason: 1 }),
        }),
      );
    });

    it('cancels the enrolment of a record made by mistake instead of closing it', async () => {
      const t = build();
      await t.service.deactivate(owner, 'student-1', { reason: 2 });
      expect(t.updateEnrolment).toHaveBeenCalledWith(expect.anything(), 'enrolment-1', {
        status: 0,
        updated_by: 'owner-1',
      });
    });

    it('cancels an enrolment that has not begun, whatever the reason, and ends its placement on its first day', async () => {
      for (const reason of [1, 2, 3]) {
        const t = build();
        t.openPlacement.mockResolvedValueOnce({
          ...placedRow,
          start_date: '2026-12-01',
          enrolled_date: '2026-12-01',
        });
        await t.service.deactivate(owner, 'student-1', { reason });
        expect(t.updatePlacement.mock.calls[0]![2]).toMatchObject({ end_date: '2026-12-01' });
        expect(t.updateEnrolment).toHaveBeenCalledWith(expect.anything(), 'enrolment-1', {
          status: 0,
          updated_by: 'owner-1',
        });
        expect(t.update.mock.calls[0]![2]).toMatchObject({ status: 0, inactive_reason: reason });
      }
    });

    it('never ends a placement or an enrolment before it began', async () => {
      const t = build();
      t.openPlacement.mockResolvedValueOnce({
        ...placedRow,
        start_date: '2026-11-11',
        enrolled_date: '2026-11-11',
      });
      t.openYear.mockResolvedValueOnce({
        open: true,
        startDate: '2026-06-01',
        endDate: '2027-03-31',
      });
      await t.service.deactivate(owner, 'student-1', { reason: 3 });
      expect(t.updatePlacement.mock.calls[0]![2]).toMatchObject({ end_date: '2026-11-11' });
      expect(t.updateEnrolment.mock.calls[0]![2]).toMatchObject({ left_date: '2026-11-11' });
    });

    it('ends both on the last day of the year once the year has ended but not been promoted', async () => {
      const t = build();
      t.openYear.mockResolvedValueOnce({
        open: true,
        startDate: '2026-06-01',
        endDate: '2026-09-30',
      });
      await t.service.deactivate(owner, 'student-1', { reason: 1 });
      expect(t.openYear).toHaveBeenCalledWith(expect.anything(), 'year-1', 'institution-1');
      expect(t.updatePlacement.mock.calls[0]![2]).toMatchObject({ end_date: '2026-09-30' });
      expect(t.updateEnrolment.mock.calls[0]![2]).toMatchObject({
        left_date: '2026-09-30',
        outcome: 3,
      });
    });

    it('records what became of the enrolment and the placement in the audit entry', async () => {
      const t = build();
      await t.service.deactivate(owner, 'student-1', { reason: 1 });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        before: {
          placementEndDate: null,
          enrolmentStatus: 1,
          enrolmentLeftDate: null,
          enrolmentOutcome: null,
        },
        after: {
          placementEndDate: '2026-11-11',
          enrolmentStatus: 1,
          enrolmentLeftDate: '2026-11-11',
          enrolmentOutcome: 3,
        },
      });
      const mistake = build();
      await mistake.service.deactivate(owner, 'student-1', { reason: 2 });
      expect(mistake.record.mock.calls[0]![1]).toMatchObject({
        after: { enrolmentStatus: 0, enrolmentLeftDate: null, enrolmentOutcome: null },
      });
    });

    it('is 404 when the student is already deactivated, or not at an Institution the caller reaches', async () => {
      const t = build(row({ status: 0 }));
      expect((await fail(t.service.deactivate(owner, 'student-1', { reason: 1 }))).status).toBe(
        404,
      );
      expect(t.update).not.toHaveBeenCalled();
      const u = build();
      u.requireInstitution.mockRejectedValueOnce(AppException.notFound());
      expect((await fail(u.service.deactivate(owner, 'student-1', { reason: 1 }))).status).toBe(
        404,
      );
    });
  });

  describe('correctClass (STU-12)', () => {
    it('puts the enrolment and every placement in the new class, the open one with the roll number, and audits it', async () => {
      const t = build();
      inClass2(t);
      const done = await t.service.correctClass(owner, 'student-1', correct({ rollNumber: '3' }));
      expect(t.deferPlacementClassKey).toHaveBeenCalledOnce();
      expect(t.updateEnrolment).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'enrolment-1', {
        class_id: 'class-2',
        updated_by: 'owner-1',
      });
      expect(t.updatePlacement).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'placement-1', {
        class_id: 'class-2',
        section_id: 'section-9',
        roll_number: '3',
        updated_by: 'owner-1',
      });
      expect(t.updateOtherPlacements).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        'enrolment-1',
        'placement-1',
        { class_id: 'class-2', section_id: 'section-9', updated_by: 'owner-1' },
      );
      expect(done.data.placement).toMatchObject({
        classId: 'class-2',
        sectionId: 'section-9',
        rollNumber: '3',
        startDate: '2026-11-11',
      });
      expect(done.options).toMatchObject({ status: 200, code: 'OK', meta: null });
      expect(t.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'student.class_corrected',
          before: expect.objectContaining({ classId: 'class-1', sectionId: 'section-1' }),
          after: expect.objectContaining({ classId: 'class-2', sectionId: 'section-9' }),
        }),
      );
    });

    it('keeps in the audit the placements it rewrites as they were, read before they change', async () => {
      const t = build();
      inClass2(t);
      const earlier = {
        id: 'placement-0',
        class_id: 'class-1',
        section_id: 'section-0',
        roll_number: '9',
        start_date: '2026-05-01',
        end_date: '2026-05-09',
      };
      t.otherPlacements.mockResolvedValue([earlier]);
      await t.service.correctClass(owner, 'student-1', correct());
      expect(t.otherPlacements).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        'enrolment-1',
        'placement-1',
      );
      expect(t.otherPlacements.mock.invocationCallOrder[0]).toBeLessThan(
        t.updateOtherPlacements.mock.invocationCallOrder[0]!,
      );
      expect(t.record.mock.calls.at(-1)![1].before).toMatchObject({
        otherPlacements: [
          {
            id: 'placement-0',
            classId: 'class-1',
            sectionId: 'section-0',
            rollNumber: '9',
            startDate: '2026-05-01',
            endDate: '2026-05-09',
          },
        ],
      });
    });

    it('keeps the roll number when none is sent', async () => {
      const t = build();
      inClass2(t);
      await t.service.correctClass(owner, 'student-1', correct());
      expect(t.updatePlacement.mock.calls[0]![2]).toMatchObject({ roll_number: '14' });
    });

    it('is 422 CLASS_UNCHANGED for the class the student is in, and writes nothing', async () => {
      const t = build();
      await expect(
        t.service.correctClass(owner, 'student-1', correct({ classId: 'class-1' })),
      ).rejects.toMatchObject({ code: 'CLASS_UNCHANGED' });
      expect(t.updateEnrolment).not.toHaveBeenCalled();
    });

    it('is 422 NO_CURRENT_PLACEMENT for a student without an open placement', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(undefined);
      await expect(t.service.correctClass(owner, 'student-1', correct())).rejects.toMatchObject({
        code: 'NO_CURRENT_PLACEMENT',
      });
    });

    it('is 422 SECTION_NOT_IN_CLASS for a section of another class, and INACTIVE_SECTION for a closed one', async () => {
      const t = build();
      await expect(t.service.correctClass(owner, 'student-1', correct())).rejects.toMatchObject({
        code: 'SECTION_NOT_IN_CLASS',
      });
      t.placeOf.mockResolvedValue({
        classId: 'class-2',
        institutionId: 'institution-1',
        active: false,
        capacity: null,
      });
      await expect(t.service.correctClass(owner, 'student-1', correct())).rejects.toMatchObject({
        code: 'INACTIVE_SECTION',
      });
      expect(t.updateEnrolment).not.toHaveBeenCalled();
    });

    it('is 404 for a section of another Institution', async () => {
      const t = build();
      t.placeOf.mockResolvedValue({
        classId: 'class-2',
        institutionId: 'institution-2',
        active: true,
        capacity: null,
      });
      await expect(t.service.correctClass(owner, 'student-1', correct())).rejects.toMatchObject({
        status: 404,
      });
    });

    it('warns when the section is over its capacity, and does not stop', async () => {
      const t = build();
      inClass2(t, 1);
      t.sectionCount.mockResolvedValue(2);
      const done = await t.service.correctClass(owner, 'student-1', correct());
      expect(done.options.meta).toEqual({ warnings: ['SECTION_OVER_CAPACITY'] });
      // The count is of the section the student is put in, in the year they are enrolled in.
      expect(t.sectionCount.mock.calls[0]!.slice(1)).toEqual(['year-1', 'section-9']);
    });

    it('is 409 ROLL_NUMBER_TAKEN when the roll number is held in the section', async () => {
      const t = build();
      inClass2(t);
      t.updatePlacement.mockRejectedValue(
        Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_placements_roll' }),
      );
      await expect(t.service.correctClass(owner, 'student-1', correct())).rejects.toMatchObject({
        code: 'ROLL_NUMBER_TAKEN',
      });
    });

    describe('for a student who came from an earlier year', () => {
      const came = { id: 'enrolment-0', class_id: 'class-0', outcome: 1 };

      it('refuses a class below the one they left, and changes nothing', async () => {
        const t = build();
        inClass2(t);
        t.previousEnrolment.mockResolvedValue(came);
        t.isBelow.mockResolvedValue(true);
        await expect(t.service.correctClass(owner, 'student-1', correct())).rejects.toMatchObject({
          code: 'TARGET_CLASS_BELOW_SOURCE',
        });
        expect(t.isBelow).toHaveBeenCalledWith(
          expect.anything(),
          'class-2',
          'class-0',
          'institution-1',
        );
        expect(t.updateEnrolment).not.toHaveBeenCalled();
      });

      it('is 404 when the class they left cannot be seen', async () => {
        const t = build();
        inClass2(t);
        t.previousEnrolment.mockResolvedValue(came);
        t.isBelow.mockResolvedValue(undefined);
        await expect(t.service.correctClass(owner, 'student-1', correct())).rejects.toMatchObject({
          status: 404,
        });
      });

      it('makes that year Repeating when the class is the one they left', async () => {
        const t = build();
        inClass2(t);
        t.previousEnrolment.mockResolvedValue({ ...came, class_id: 'class-2' });
        await t.service.correctClass(owner, 'student-1', correct());
        expect(t.isBelow).not.toHaveBeenCalled();
        expect(t.updateEnrolment).toHaveBeenCalledWith(expect.anything(), 'enrolment-0', {
          outcome: 2,
          updated_by: 'owner-1',
        });
        expect(t.record).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            before: expect.objectContaining({ previousOutcome: 1 }),
            after: expect.objectContaining({ previousOutcome: 2 }),
          }),
        );
      });

      it('leaves that year alone when its outcome already fits', async () => {
        const t = build();
        inClass2(t);
        t.previousEnrolment.mockResolvedValue(came);
        await t.service.correctClass(owner, 'student-1', correct());
        expect(t.updateEnrolment).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          'enrolment-1',
          expect.anything(),
        );
      });
    });
  });

  describe('move (STU-08)', () => {
    it('closes the open placement the day before and opens the next, with the new section and roll number', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(openAt('2026-06-01'));
      t.placeOf.mockResolvedValue({
        classId: 'class-1',
        institutionId: 'institution-1',
        active: true,
        capacity: null,
      });
      const moved = await t.service.move(
        owner,
        'student-1',
        move({ sectionId: 'section-2', rollNumber: '3', effectiveDate: '2026-11-01' }),
      );
      expect(t.updatePlacement).toHaveBeenCalledWith(expect.anything(), 'placement-1', {
        end_date: '2026-10-31',
        updated_by: 'owner-1',
      });
      expect(t.insertPlacement).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          society_id: 'society-1',
          institution_id: 'institution-1',
          created_by: 'owner-1',
          academic_year_id: 'year-1',
          student_enrolment_id: 'enrolment-1',
          class_id: 'class-1',
          section_id: 'section-2',
          roll_number: '3',
          start_date: '2026-11-01',
        }),
      );
      expect(moved.data.placement).toMatchObject({
        sectionId: 'section-2',
        rollNumber: '3',
        startDate: '2026-11-01',
      });
      expect(moved.options).toMatchObject({ status: 200, code: 'OK', meta: null });
      expect(t.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'student.placement_changed',
          before: expect.objectContaining({ sectionId: 'section-1', rollNumber: '14' }),
          after: expect.objectContaining({ sectionId: 'section-2', rollNumber: '3' }),
        }),
      );
    });

    it('takes today as the day, and keeps what is not sent', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(openAt('2026-06-01'));
      await t.service.move(owner, 'student-1', move({ rollNumber: '15' }));
      expect(t.updatePlacement.mock.calls[0]![2]).toMatchObject({ end_date: '2026-11-10' });
      expect(t.insertPlacement.mock.calls[0]![1]).toMatchObject({
        section_id: 'section-1',
        roll_number: '15',
        start_date: '2026-11-11',
      });
    });

    it('corrects the placement in place on the day it began, with nothing to close', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(openAt('2026-11-11'));
      await t.service.move(owner, 'student-1', move({ rollNumber: '15' }));
      expect(t.insertPlacement).not.toHaveBeenCalled();
      expect(t.updatePlacement).toHaveBeenCalledWith(expect.anything(), 'placement-1', {
        section_id: 'section-1',
        roll_number: '15',
        updated_by: 'owner-1',
      });
    });

    it('writes nothing for a request that changes nothing', async () => {
      const t = build();
      const moved = await t.service.move(
        owner,
        'student-1',
        move({ sectionId: 'section-1', rollNumber: '14', effectiveDate: '2999-01-01' }),
      );
      await t.service.move(owner, 'student-1', move());
      expect(t.updatePlacement).not.toHaveBeenCalled();
      expect(t.insertPlacement).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
      expect(moved.data.placement).toMatchObject({ sectionId: 'section-1', rollNumber: '14' });
    });

    it('refuses a day in the future or before the current placement began', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(openAt('2026-11-05'));
      for (const effectiveDate of ['2026-11-12', '2026-11-04']) {
        const refused = await fail(
          t.service.move(owner, 'student-1', move({ rollNumber: '15', effectiveDate })),
        );
        expect(refused.status).toBe(400);
        expect(refused.fields).toEqual([expect.objectContaining({ field: 'effectiveDate' })]);
      }
      expect(t.updatePlacement).not.toHaveBeenCalled();
    });

    it('corrects in place, on its first day, a placement that begins later (a child admitted ahead)', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(openAt('2026-12-01'));
      const moved = await t.service.move(owner, 'student-1', move({ rollNumber: '15' }));
      expect(t.insertPlacement).not.toHaveBeenCalled();
      expect(t.updatePlacement).toHaveBeenCalledWith(
        expect.anything(),
        'placement-1',
        expect.objectContaining({ roll_number: '15' }),
      );
      expect(moved.data.placement).toMatchObject({ rollNumber: '15', startDate: '2026-12-01' });
    });

    it('never opens a placement after the year ended: the default day is the last of the year', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(openAt('2026-06-01'));
      t.openYear.mockResolvedValue({ open: true, startDate: '2026-06-01', endDate: '2026-11-01' });
      await t.service.move(owner, 'student-1', move({ rollNumber: '15' }));
      expect(t.updatePlacement.mock.calls[0]![2]).toMatchObject({ end_date: '2026-10-31' });
      expect(t.insertPlacement.mock.calls[0]![1]).toMatchObject({ start_date: '2026-11-01' });
      const refused = await fail(
        t.service.move(owner, 'student-1', move({ rollNumber: '16', effectiveDate: '2026-11-05' })),
      );
      expect(refused.status).toBe(400);
      expect(refused.fields).toEqual([expect.objectContaining({ field: 'effectiveDate' })]);
    });

    it('is 404 for another Institution’s section, 422 for a section of another class or one that is closed, and 422 for a year that is closed', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(openAt('2026-06-01'));
      const place = {
        classId: 'class-1',
        institutionId: 'institution-1',
        active: true,
        capacity: null,
      };
      t.placeOf.mockResolvedValueOnce({ ...place, institutionId: 'institution-2' });
      expect(
        (await fail(t.service.move(owner, 'student-1', move({ sectionId: 'x' })))).status,
      ).toBe(404);
      t.placeOf.mockResolvedValueOnce({ ...place, classId: 'class-2' });
      expect((await fail(t.service.move(owner, 'student-1', move({ sectionId: 'x' })))).code).toBe(
        'SECTION_NOT_IN_CLASS',
      );
      t.placeOf.mockResolvedValueOnce({ ...place, active: false });
      expect((await fail(t.service.move(owner, 'student-1', move({ sectionId: 'x' })))).code).toBe(
        'INACTIVE_SECTION',
      );
      t.openYear.mockResolvedValueOnce({
        open: false,
        startDate: '2026-06-01',
        endDate: '2027-03-31',
      });
      expect((await fail(t.service.move(owner, 'student-1', move({ sectionId: 'x' })))).code).toBe(
        'YEAR_NOT_ACTIVE',
      );
      expect(t.updatePlacement).not.toHaveBeenCalled();
    });

    it('answers a taken roll number in the words of the API', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(openAt('2026-06-01'));
      t.insertPlacement.mockRejectedValueOnce(unique('uq_placements_roll'));
      const refused = await fail(t.service.move(owner, 'student-1', move({ rollNumber: '1' })));
      expect(refused.status).toBe(409);
      expect(refused.code).toBe('ROLL_NUMBER_TAKEN');
    });

    it('warns, and still moves, when the section is now over its capacity', async () => {
      const t = build();
      t.openPlacement.mockResolvedValue(openAt('2026-06-01'));
      t.placeOf.mockResolvedValue({
        classId: 'class-1',
        institutionId: 'institution-1',
        active: true,
        capacity: 1,
      });
      t.sectionCount.mockResolvedValue(2);
      const moved = await t.service.move(owner, 'student-1', move({ sectionId: 'section-2' }));
      expect(moved.options.status).toBe(200);
      expect(moved.options.meta).toEqual({ warnings: ['SECTION_OVER_CAPACITY'] });
    });

    it('is 404 for a deactivated student and for one with no open placement', async () => {
      const t = build(row({ status: 0 }));
      expect(
        (await fail(t.service.move(owner, 'student-1', move({ rollNumber: '2' })))).status,
      ).toBe(404);
      const u = build();
      u.openPlacement.mockResolvedValue(undefined);
      expect(
        (await fail(u.service.move(owner, 'student-1', move({ rollNumber: '2' })))).status,
      ).toBe(404);
    });
  });

  describe('block and unblock (STU-06, STU-07)', () => {
    const blockedAt = new Date('2026-11-11T04:30:00.000Z');

    it('blocks an active student at once, stamps who and when, audits it and answers the profile', async () => {
      const t = build();
      const blocked = await t.service.block(owner, 'student-1');
      expect(t.requireInstitution).toHaveBeenCalledWith(owner, 'institution-1');
      expect(t.find).toHaveBeenCalledWith(expect.anything(), 'student-1', true);
      expect(t.update).toHaveBeenCalledWith(
        expect.anything(),
        'student-1',
        expect.objectContaining({
          access_blocked_at: blockedAt,
          access_blocked_by: 'owner-1',
          updated_by: 'owner-1',
        }),
      );
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'student.blocked',
        institutionId: 'institution-1',
        entityType: 'student',
        entityId: 'student-1',
        before: { isBlocked: false },
        after: { isBlocked: true },
      });
      expect(blocked).toMatchObject({ id: 'student-1', isBlocked: true, version: 2 });
    });

    it('lifts the block and clears who and when', async () => {
      const t = build(row({ access_blocked_at: blockedAt, access_blocked_by: 'owner-1' }));
      const unblocked = await t.service.unblock(owner, 'student-1');
      expect(t.update).toHaveBeenCalledWith(
        expect.anything(),
        'student-1',
        expect.objectContaining({
          access_blocked_at: null,
          access_blocked_by: null,
          updated_by: 'owner-1',
        }),
      );
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'student.unblocked',
        before: { isBlocked: true },
        after: { isBlocked: false },
      });
      expect(unblocked).toMatchObject({ isBlocked: false, blockedAt: null });
    });

    it('is 409 INVALID_STATE for a student already blocked, or one that is not blocked, and writes nothing', async () => {
      const already = build(row({ access_blocked_at: blockedAt, access_blocked_by: 'owner-1' }));
      expect(await fail(already.service.block(owner, 'student-1'))).toMatchObject({
        status: 409,
        code: 'INVALID_STATE',
      });
      const open = build();
      expect(await fail(open.service.unblock(owner, 'student-1'))).toMatchObject({
        status: 409,
        code: 'INVALID_STATE',
      });
      expect(already.update).not.toHaveBeenCalled();
      expect(open.update).not.toHaveBeenCalled();
      expect(open.record).not.toHaveBeenCalled();
    });

    it('is 404 for a deactivated student and for one who is not found, whoever asks', async () => {
      expect((await fail(build(row({ status: 0 })).service.block(owner, 'student-1'))).status).toBe(
        404,
      );
      expect((await fail(build(null).service.unblock(owner, 'student-1'))).status).toBe(404);
    });
  });
});
