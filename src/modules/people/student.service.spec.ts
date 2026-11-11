import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { FileDirectory } from '../../platform/files/index.js';
import type { AccountDirectory, PersonDirectory } from '../../platform/identity/index.js';
import type { MasterReferences } from '../../platform/masters/index.js';
import type { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import type { AcademicYearDirectory, SectionDirectory } from '../academic-setup/index.js';
import { StudentContext } from './student-context.js';
import type { CreateStudentDto, ListStudentsQueryDto } from './student.dto.js';
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
  const placedNow = vi.fn<StudentRepository['placedNow']>().mockResolvedValue(placedRow);
  const sectionCount = vi.fn<StudentRepository['sectionCount']>().mockResolvedValue(1);
  const page = vi
    .fn<StudentRepository['page']>()
    .mockResolvedValue({ rows: [{ ...row(), ...placedRow }], total: 41 });
  const requirePlace = vi.fn<MasterReferences['requirePlace']>().mockResolvedValue(undefined);
  const requireReady = vi.fn<FileDirectory['requireReady']>().mockResolvedValue(undefined);
  const openIn = vi.fn<AcademicYearDirectory['openIn']>().mockResolvedValue(true);
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
    placedNow,
    sectionCount,
    page,
  } as unknown as StudentRepository;
  const scopeService = { requireInstitution, forPrincipal } as unknown as ScopeService;
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
    {
      openIn,
      spanOf: vi
        .fn<AcademicYearDirectory['spanOf']>()
        .mockResolvedValue({ startDate: '2026-06-01', endDate: '2027-03-31' }),
    } as unknown as AcademicYearDirectory,
    { placeOf } as unknown as SectionDirectory,
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
    placedNow,
    sectionCount,
    page,
    requirePlace,
    requireReady,
    openIn,
    placeOf,
    requireInstitution,
    forPrincipal,
    linkGuardian,
    welcomeAs,
    record,
  };
}

const query = (fields: object = {}) =>
  Object.assign({ page: 2, limit: 20 }, fields) as ListStudentsQueryDto;

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
      t.openIn.mockResolvedValueOnce(undefined);
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
      t.openIn.mockResolvedValueOnce(false);
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
      t.linkGuardian.mockRejectedValueOnce(AppException.conflict('ROLE_CONFLICT'));
      expect(await fail(t.service.create(owner, body()))).toMatchObject({
        status: 409,
        code: 'ROLE_CONFLICT',
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

    it('is 404 for a student who is not there, and for an Institution the caller does not reach', async () => {
      const t = build(null);
      expect((await fail(t.service.get(owner, 'student-1'))).status).toBe(404);
      const u = build();
      u.requireInstitution.mockRejectedValueOnce(AppException.notFound());
      expect((await fail(u.service.get(owner, 'student-1'))).status).toBe(404);
    });
  });
});
