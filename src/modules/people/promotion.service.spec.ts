import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { Clock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { IdempotencyService } from '../../platform/idempotency/index.js';
import type { ScopeService } from '../../platform/tenancy/index.js';
import type {
  AcademicYearDirectory,
  ClassDirectory,
  SectionDirectory,
} from '../academic-setup/index.js';
import type { PromoteClassDto, PromoteStudentDto } from './promotion.dto.js';
import { PromotionService, targetOf } from './promotion.service.js';
import { StudentContext } from './student-context.js';
import type {
  EnrolmentRow,
  PlacedRow,
  PromotableRow,
  StudentRepository,
  StudentRow,
} from './student.repository.js';
import type { StudentResource } from './student.resource.js';
import type { StudentService } from './student.service.js';

const admin = { personId: 'admin-1', roleCode: 3, societyId: 'society-1' } as unknown as Principal;

const row = (n: number, roll = String(n)): PromotableRow => ({
  student_id: `student-${n}`,
  institution_id: 'institution-1',
  society_id: 'society-1',
  enrolment_id: `enrolment-${n}`,
  placement_id: `placement-${n}`,
  section_id: 'section-1',
  roll_number: roll,
  start_date: '2026-06-01',
});

const target = {
  toAcademicYearId: 'year-2',
  toClassId: 'class-2',
  toSectionId: 'section-2',
};
const nobody = { toAcademicYearId: null, toClassId: null, toSectionId: null };
const batch = (fields: Partial<PromoteClassDto> = {}) =>
  ({
    institutionId: 'institution-1',
    fromAcademicYearId: 'year-1',
    fromClassId: 'class-1',
    fromSectionId: 'section-1',
    ...target,
    ...fields,
  }) as PromoteClassDto;

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) {
      return { status: error.status as number, code: error.code, details: error.options.details };
    }
    throw error;
  }
  throw new Error('expected a refusal');
};

interface Options {
  rows?: PromotableRow[];
  enrolled?: string[];
  isLast?: boolean | undefined;
  below?: boolean | undefined;
  targetYear?: { open: boolean; startDate: string; endDate: string } | undefined;
  targetSection?: {
    classId: string;
    institutionId: string;
    active: boolean;
    capacity: number | null;
  };
  taken?: string[];
  count?: number;
}

function build(options: Options = {}) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const promotable = vi
    .fn<StudentRepository['promotable']>()
    .mockResolvedValue(options.rows ?? [row(1), row(2)]);
  const enrolledIn = vi
    .fn<StudentRepository['enrolledIn']>()
    .mockResolvedValue(new Set(options.enrolled ?? []));
  const rollNumbersIn = vi
    .fn<StudentRepository['rollNumbersIn']>()
    .mockResolvedValue(options.taken ?? []);
  const sectionCount = vi
    .fn<StudentRepository['sectionCount']>()
    .mockResolvedValue(options.count ?? 2);
  const updatePlacement = vi.fn<StudentRepository['updatePlacement']>().mockResolvedValue();
  const updateEnrolment = vi.fn<StudentRepository['updateEnrolment']>().mockResolvedValue();
  const insertEnrolment = vi
    .fn<StudentRepository['insertEnrolment']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve({ ...values, id: `new-${values.student_id}` } as EnrolmentRow),
    );
  const insertPlacement = vi
    .fn<StudentRepository['insertPlacement']>()
    .mockResolvedValue({} as never);
  const openPlacement = vi.fn<StudentRepository['openPlacement']>().mockResolvedValue({
    placement_id: 'placement-1',
    enrolment_id: 'enrolment-1',
    academic_year_id: 'year-1',
    class_id: 'class-1',
    section_id: 'section-1',
    roll_number: '1',
    start_date: '2026-06-01',
    enrolled_date: '2026-06-01',
  } satisfies PlacedRow);
  const find = vi.fn<StudentRepository['find']>().mockResolvedValue({
    id: 'student-1',
    status: 1,
    institution_id: 'institution-1',
  } as StudentRow);
  const openYear = vi
    .fn<AcademicYearDirectory['openYear']>()
    .mockImplementation((_tx, id) =>
      Promise.resolve(
        id === 'year-1'
          ? { open: true, startDate: '2026-06-01', endDate: '2027-03-31' }
          : 'targetYear' in options
            ? options.targetYear
            : { open: true, startDate: '2027-06-01', endDate: '2028-03-31' },
      ),
    );
  const isLast = vi
    .fn<ClassDirectory['isLast']>()
    .mockResolvedValue('isLast' in options ? options.isLast : false);
  const isBelow = vi
    .fn<ClassDirectory['isBelow']>()
    .mockResolvedValue('below' in options ? options.below : false);
  const markCompleted = vi.fn<StudentRepository['markCompleted']>().mockResolvedValue();
  const now = new Date('2027-03-31T10:00:00Z');
  const placeOf = vi.fn<SectionDirectory['placeOf']>().mockImplementation((_tx, id) =>
    Promise.resolve(
      id === 'section-1'
        ? { classId: 'class-1', institutionId: 'institution-1', active: true, capacity: null }
        : (options.targetSection ?? {
            classId: 'class-2',
            institutionId: 'institution-1',
            active: true,
            capacity: 40,
          }),
    ),
  );
  const names = vi
    .fn<SectionDirectory['names']>()
    .mockResolvedValue(
      new Map([['section-2', { displayName: 'Section 1', classId: 'class-2', className: '7th' }]]),
    );
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
  const run = vi
    .fn<IdempotencyService['run']>()
    .mockImplementation((_call, work) => work(tx).then((outcome) => outcome.result as never));
  const get = vi
    .fn<StudentService['get']>()
    .mockResolvedValue({ id: 'student-1' } as unknown as StudentResource);
  const database = { transaction } as unknown as DatabaseService;
  const students = {
    find,
    promotable,
    enrolledIn,
    rollNumbersIn,
    sectionCount,
    updatePlacement,
    updateEnrolment,
    insertEnrolment,
    insertPlacement,
    openPlacement,
    markCompleted,
  } as unknown as StudentRepository;
  const scope = { requireInstitution, forPrincipal } as unknown as ScopeService;
  const service = new PromotionService(
    database,
    students,
    { get } as unknown as StudentService,
    new StudentContext(database, students, scope),
    scope,
    { openYear } as unknown as AcademicYearDirectory,
    { isLast, isBelow } as unknown as ClassDirectory,
    { placeOf, names } as unknown as SectionDirectory,
    { record } as unknown as AuditService,
    { run } as unknown as IdempotencyService,
    { now: () => now } as unknown as Clock,
  );
  return {
    service,
    promotable,
    enrolledIn,
    rollNumbersIn,
    updatePlacement,
    updateEnrolment,
    insertEnrolment,
    insertPlacement,
    openPlacement,
    markCompleted,
    isBelow,
    now,
    record,
    run,
    openYear,
    placeOf,
    get,
  };
}

/** The target section is one of the source class, as it is for a student who repeats the class. */
const inClass1: Options = {
  targetSection: { classId: 'class-1', institutionId: 'institution-1', active: true, capacity: 40 },
};

const attempt = () => targetOf({ ...target, toClassId: null, toSectionId: null });

describe('targetOf', () => {
  it('is the target when all three parts are given, and none for a student who completes', () => {
    expect(targetOf(target)).toEqual({
      academicYearId: 'year-2',
      classId: 'class-2',
      sectionId: 'section-2',
    });
    expect(targetOf(nobody)).toBeNull();
  });

  it('is 400 REQUIRED for each part left out of a target that is partly given', () => {
    expect(attempt).toThrow(AppException);
    const error = (() => {
      try {
        attempt();
      } catch (caught) {
        return caught as AppException;
      }
      return undefined;
    })();
    expect(error?.status).toBe(400);
    expect(error?.options.errors?.map((f) => f.field)).toEqual(['toClassId', 'toSectionId']);
  });
});

describe('PromotionService.promoteClass (PRM-01)', () => {
  it('ends the old placement on the old year’s last day and the enrolment as Promoted, and begins the new ones', async () => {
    const t = build();
    const result = await t.service.promoteClass(admin, 'key-1', batch());
    expect(result.data).toEqual({ promotedCount: 2, skipped: [] });
    expect(result.options).toMatchObject({
      status: 200,
      code: 'PROMOTED',
      message: '2 students promoted to 7th Section 1',
      meta: null,
    });
    expect(t.updatePlacement).toHaveBeenCalledWith(
      expect.anything(),
      'placement-1',
      expect.objectContaining({ end_date: '2027-03-31', updated_by: 'admin-1' }),
    );
    expect(t.updateEnrolment).toHaveBeenCalledWith(
      expect.anything(),
      'enrolment-1',
      expect.objectContaining({ outcome: 1, updated_by: 'admin-1' }),
    );
    expect(t.insertEnrolment.mock.calls[0]![1]).toMatchObject({
      society_id: 'society-1',
      institution_id: 'institution-1',
      academic_year_id: 'year-2',
      student_id: 'student-1',
      class_id: 'class-2',
      enrolled_date: '2027-06-01',
      created_by: 'admin-1',
    });
    expect(t.insertPlacement.mock.calls[0]![1]).toMatchObject({
      academic_year_id: 'year-2',
      student_enrolment_id: 'new-student-1',
      class_id: 'class-2',
      section_id: 'section-2',
      roll_number: '1',
      start_date: '2027-06-01',
    });
    expect(t.record.mock.calls).toHaveLength(1);
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'student.promoted',
      institutionId: 'institution-1',
      after: { promotedCount: 2, skippedCount: 0, outcome: 1, toClassId: 'class-2' },
    });
  });

  it('runs inside the idempotency store with the person’s tenant, the key and the body', async () => {
    const t = build();
    const body = batch();
    await t.service.promoteClass(admin, 'key-1', body);
    expect(t.run.mock.calls[0]![0]).toMatchObject({
      tenant: { personId: 'admin-1' },
      key: 'key-1',
      operation: 'students.promote',
      request: body,
    });
  });

  it('records Repeating for the same class', async () => {
    const t = build({
      targetSection: {
        classId: 'class-1',
        institutionId: 'institution-1',
        active: true,
        capacity: null,
      },
    });
    await t.service.promoteClass(admin, 'k', batch({ toClassId: 'class-1' }));
    expect(t.updateEnrolment).toHaveBeenCalledWith(
      expect.anything(),
      'enrolment-1',
      expect.objectContaining({ outcome: 2 }),
    );
  });

  it('skips a student already enrolled in the target year, and one asked for who is not in the source', async () => {
    const t = build({ enrolled: ['student-2'] });
    const result = await t.service.promoteClass(
      admin,
      'k',
      batch({ studentIds: ['student-1', 'student-2', 'student-9'] }),
    );
    expect(result.data).toEqual({
      promotedCount: 1,
      skipped: [
        { studentId: 'student-9', reason: 'NOT_IN_SOURCE' },
        { studentId: 'student-2', reason: 'ALREADY_ENROLLED' },
      ],
    });
    expect(t.insertEnrolment).toHaveBeenCalledTimes(1);
    expect(t.updateEnrolment).toHaveBeenCalledTimes(1);
  });

  it('writes and audits nothing when nobody is left to promote', async () => {
    const t = build({ rows: [] });
    const result = await t.service.promoteClass(admin, 'k', batch());
    expect(result.data).toEqual({ promotedCount: 0, skipped: [] });
    expect(t.record).not.toHaveBeenCalled();
    expect(t.updatePlacement).not.toHaveBeenCalled();
  });

  it('numbers the students again after the target section’s highest number when asked not to keep the rolls', async () => {
    const t = build({ rows: [row(1, '5'), row(2, '3')], taken: ['10'] });
    await t.service.promoteClass(admin, 'k', batch({ keepRollNumbers: false }));
    expect(t.insertPlacement.mock.calls.map((c) => c[1].roll_number)).toEqual(['12', '11']);
  });

  it('keeps the roll numbers by default', async () => {
    const t = build({ rows: [row(1, 'A7')] });
    await t.service.promoteClass(admin, 'k', batch());
    expect(t.insertPlacement.mock.calls[0]![1]).toMatchObject({ roll_number: 'A7' });
    expect(t.rollNumbersIn).not.toHaveBeenCalled();
  });

  it('warns when the target section holds more students than its capacity', async () => {
    const t = build({
      count: 41,
    });
    const result = await t.service.promoteClass(admin, 'k', batch());
    expect(result.options.meta).toEqual({ warnings: ['SECTION_OVER_CAPACITY'] });
  });

  it('completes the final class: Completed, the old placement ends, and nothing begins', async () => {
    const t = build({ isLast: true });
    const result = await t.service.promoteClass(admin, 'k', batch({ ...nobody }));
    expect(result.data.promotedCount).toBe(2);
    expect(result.options.message).toBe('2 students completed the final class');
    expect(t.updateEnrolment).toHaveBeenCalledWith(
      expect.anything(),
      'enrolment-1',
      expect.objectContaining({ outcome: 4 }),
    );
    expect(t.insertEnrolment).not.toHaveBeenCalled();
    expect(t.insertPlacement).not.toHaveBeenCalled();
    expect(t.enrolledIn).not.toHaveBeenCalled();
  });

  it('deactivates the students who complete the final class, as Completed, and says so in the audit', async () => {
    const t = build({ isLast: true });
    await t.service.promoteClass(admin, 'k', batch({ ...nobody }));
    expect(t.markCompleted).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      ['student-1', 'student-2'],
      {
        inactive_reason: 4,
        inactive_at: t.now,
        updated_by: 'admin-1',
      },
    );
    const deactivated = t.record.mock.calls.filter(
      ([, entry]) => entry.action === 'student.deactivated',
    );
    expect(deactivated.map(([, entry]) => [entry.entityId, entry.before, entry.after])).toEqual([
      ['student-1', { status: 1, inactiveReason: null }, { status: 0, inactiveReason: 4 }],
      ['student-2', { status: 1, inactiveReason: null }, { status: 0, inactiveReason: 4 }],
    ]);
  });

  it('deactivates nobody who is promoted, repeats, or is skipped', async () => {
    const promoted = build();
    await promoted.service.promoteClass(admin, 'k', batch());
    const repeat = build(inClass1);
    await repeat.service.promoteClass(admin, 'k', batch({ toClassId: 'class-1' }));
    const skipped = build({ isLast: true, rows: [] });
    await skipped.service.promoteClass(admin, 'k', batch({ ...nobody }));
    for (const t of [promoted, repeat, skipped]) expect(t.markCompleted).not.toHaveBeenCalled();
  });

  it('lets a student stay in the same class (a repeat) without asking about the order of the classes', async () => {
    const t = build({ below: true, ...inClass1 });
    await t.service.promoteClass(admin, 'k', batch({ toClassId: 'class-1' }));
    expect(t.isBelow).not.toHaveBeenCalled();
    expect(t.updateEnrolment).toHaveBeenCalledWith(
      expect.anything(),
      'enrolment-1',
      expect.objectContaining({ outcome: 2 }),
    );
  });

  it('asks whether the target class is below the source class, in the Institution', async () => {
    const t = build();
    await t.service.promoteClass(admin, 'k', batch());
    expect(t.isBelow).toHaveBeenCalledWith(
      expect.anything(),
      'class-2',
      'class-1',
      'institution-1',
    );
  });

  it.each([
    [
      'a class that is not the last cannot be completed',
      { isLast: false },
      nobody,
      422,
      'NOT_FINAL_CLASS',
    ],
    ['a source class the caller cannot see', { isLast: undefined }, {}, 404, 'NOT_FOUND'],
    [
      'a target year that is not active',
      { targetYear: { open: false, startDate: '2027-06-01', endDate: '2028-03-31' } },
      {},
      422,
      'YEAR_NOT_ACTIVE',
    ],
    ['a target year that is not there', { targetYear: undefined }, {}, 404, 'NOT_FOUND'],
    [
      'a target year that does not begin after the source year',
      { targetYear: { open: true, startDate: '2026-06-01', endDate: '2027-03-31' } },
      {},
      422,
      'TARGET_YEAR_NOT_AFTER_SOURCE',
    ],
    [
      'a section that is not of the target class',
      {
        targetSection: {
          classId: 'class-9',
          institutionId: 'institution-1',
          active: true,
          capacity: null,
        },
      },
      {},
      422,
      'SECTION_NOT_IN_CLASS',
    ],
    [
      'a section that is closed',
      {
        targetSection: {
          classId: 'class-2',
          institutionId: 'institution-1',
          active: false,
          capacity: null,
        },
      },
      {},
      422,
      'INACTIVE_SECTION',
    ],
    [
      'a target class below the source class',
      { below: true },
      {},
      422,
      'TARGET_CLASS_BELOW_SOURCE',
    ],
    ['a target class the caller cannot see', { below: undefined }, {}, 404, 'NOT_FOUND'],
    [
      'a section of another Institution',
      {
        targetSection: {
          classId: 'class-2',
          institutionId: 'institution-2',
          active: true,
          capacity: null,
        },
      },
      {},
      404,
      'NOT_FOUND',
    ],
  ] as [string, Options, Partial<PromoteClassDto>, number, string][])(
    'refuses %s, and writes nothing',
    async (_name, options, fields, status, code) => {
      const t = build(options);
      expect(await refusal(t.service.promoteClass(admin, 'k', batch(fields)))).toMatchObject({
        status,
        code,
      });
      expect(t.updatePlacement).not.toHaveBeenCalled();
      expect(t.insertEnrolment).not.toHaveBeenCalled();
    },
  );

  it('is 413 BATCH_TOO_LARGE for more than 500 students named, or found, before anything is written', async () => {
    const many = Array.from({ length: 501 }, (_, n) => `student-${n}`);
    const named = build();
    expect(
      await refusal(named.service.promoteClass(admin, 'k', batch({ studentIds: many }))),
    ).toMatchObject({
      status: 413,
      code: 'BATCH_TOO_LARGE',
    });
    expect(named.run).not.toHaveBeenCalled();
    const found = build({ rows: many.map((_, n) => row(n)) });
    expect(await refusal(found.service.promoteClass(admin, 'k', batch()))).toMatchObject({
      status: 413,
      code: 'BATCH_TOO_LARGE',
    });
    expect(found.updatePlacement).not.toHaveBeenCalled();
  });

  it('takes exactly 500 students', async () => {
    const t = build({ rows: Array.from({ length: 500 }, (_, n) => row(n)) });
    expect((await t.service.promoteClass(admin, 'k', batch())).data.promotedCount).toBe(500);
  });

  it('is 400 for a target that is only partly given, before the store is asked', async () => {
    const t = build();
    expect(
      await refusal(t.service.promoteClass(admin, 'k', batch({ toSectionId: null }))),
    ).toMatchObject({ status: 400 });
    expect(t.run).not.toHaveBeenCalled();
  });

  it('is 409 ROLL_NUMBER_TAKEN with the student when two keep one roll number in the target section', async () => {
    const t = build();
    t.insertPlacement.mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_placements_roll' }),
    );
    expect(await refusal(t.service.promoteClass(admin, 'k', batch()))).toMatchObject({
      status: 409,
      code: 'ROLL_NUMBER_TAKEN',
      details: { studentId: 'student-1' },
    });
  });
});

describe('PromotionService.promoteStudent (STU-09)', () => {
  const one = { ...target } as PromoteStudentDto;

  it('promotes the one student from their open placement and answers the profile', async () => {
    const t = build({ rows: [row(1)] });
    const result = await t.service.promoteStudent(admin, 'student-1', one);
    expect(t.promotable).toHaveBeenCalledWith(expect.anything(), {
      academicYearId: 'year-1',
      classId: 'class-1',
      sectionId: 'section-1',
      studentIds: ['student-1'],
    });
    expect(result.data).toEqual({ id: 'student-1' });
    expect(t.insertEnrolment).toHaveBeenCalledTimes(1);
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'student.promoted',
      entityType: 'student',
      entityId: 'student-1',
    });
  });

  it('takes the roll number it is given', async () => {
    const t = build({ rows: [row(1)] });
    await t.service.promoteStudent(admin, 'student-1', { ...one, rollNumber: '21' });
    expect(t.insertPlacement.mock.calls[0]![1]).toMatchObject({ roll_number: '21' });
  });

  it('is 409 ALREADY_ENROLLED for a student already in the target year, and writes nothing', async () => {
    const t = build({ rows: [row(1)], enrolled: ['student-1'] });
    expect(await refusal(t.service.promoteStudent(admin, 'student-1', one))).toMatchObject({
      status: 409,
      code: 'ALREADY_ENROLLED',
    });
    expect(t.updatePlacement).not.toHaveBeenCalled();
  });

  it('is 422 NO_CURRENT_PLACEMENT for a student with no open placement, and 400 for a target only partly given', async () => {
    const none = build();
    none.openPlacement.mockResolvedValueOnce(undefined);
    expect(await refusal(none.service.promoteStudent(admin, 'student-1', one))).toMatchObject({
      status: 422,
      code: 'NO_CURRENT_PLACEMENT',
    });
    const partly = build();
    expect(
      await refusal(partly.service.promoteStudent(admin, 'student-1', { ...one, toClassId: null })),
    ).toMatchObject({ status: 400 });
    expect(partly.updatePlacement).not.toHaveBeenCalled();
  });

  it('completes the final class for a student with no target', async () => {
    const t = build({ rows: [row(1)], isLast: true });
    const result = await t.service.promoteStudent(admin, 'student-1', {
      ...nobody,
    } as PromoteStudentDto);
    expect(t.updateEnrolment).toHaveBeenCalledWith(
      expect.anything(),
      'enrolment-1',
      expect.objectContaining({ outcome: 4 }),
    );
    expect(t.insertEnrolment).not.toHaveBeenCalled();
    expect(t.markCompleted).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      ['student-1'],
      expect.anything(),
    );
    // The profile of a deactivated student is still read (STU-03), and shows the placement they finished.
    expect(result.data).toEqual({ id: 'student-1' });
  });

  it('refuses a target class below the source class', async () => {
    const t = build({ below: true });
    expect(await refusal(t.service.promoteStudent(admin, 'student-1', one))).toMatchObject({
      status: 422,
      code: 'TARGET_CLASS_BELOW_SOURCE',
    });
    expect(t.updatePlacement).not.toHaveBeenCalled();
  });
});
