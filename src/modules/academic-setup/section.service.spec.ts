import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { MasterReferences } from '../../platform/masters/index.js';
import type { InstitutionContext, ScopeService } from '../../platform/tenancy/index.js';
import type { ClassRepository, ClassRow } from './class.repository.js';
import type { SectionRepository, SectionRow, SectionView } from './section.repository.js';
import { SectionService } from './section.service.js';
import type { SectionStudents } from './section-students.js';
import type { ClassTeacherRef, TeachingStaff } from './teaching-staff.js';

const owner = {
  personId: 'owner-1',
  sessionId: 'session-1',
  roleCode: 2,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
} as Principal;

const tenant: TenantContext = {
  personId: 'owner-1',
  roleCode: 2,
  societyId: 'society-1',
  institutionIds: ['inst-1'],
};
const context: InstitutionContext = { institutionId: 'inst-1', societyId: 'society-1', tenant };

const classRow = (overrides: Partial<ClassRow> = {}): ClassRow => ({
  id: 'class-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'owner-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'owner-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  predefined_class_id: 'pc-9',
  class_category_id: 'cat-hs',
  stream_name: null,
  display_name: '9th',
  code: null,
  ...overrides,
});

const row = (overrides: Partial<SectionRow> = {}): SectionRow => ({
  id: 'section-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'owner-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'owner-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  class_id: 'class-1',
  predefined_section_id: 'ps-a',
  display_name: 'A',
  capacity: 40,
  ...overrides,
});

const viewOf = (base: SectionRow): SectionView => ({
  ...base,
  predefined_code: 'A',
  predefined_name: 'A',
});

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) {
      return { status: error.status as number, code: error.code, errors: error.options.errors };
    }
    throw error;
  }
  throw new Error('expected a refusal');
};

const unique = (constraint: string) =>
  Object.assign(new Error('unique'), { code: '23505', constraint });

const teacher = { ...owner, personId: 'teacher-1', roleCode: 4 } as Principal;
const lead: ClassTeacherRef = { staffMemberId: 'staff-1', firstName: 'Meera', lastName: 'Rao' };

function build(current: SectionRow | null = row(), parent: ClassRow | null = classRow()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const active = vi.fn<SectionRepository['active']>().mockResolvedValue([viewOf(row())]);
  const find = vi.fn<SectionRepository['find']>().mockResolvedValue(current ?? undefined);
  const viewOfFn = vi
    .fn<SectionRepository['viewOf']>()
    .mockImplementation((_tx, id) => Promise.resolve(viewOf(row({ ...current, id }))));
  const insert = vi
    .fn<SectionRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(row({ ...(values as Partial<SectionRow>), id: 'section-new' })),
    );
  const update = vi
    .fn<SectionRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(row({ ...current, ...(changes as Partial<SectionRow>), id, version: 2 })),
    );
  const findClass = vi.fn<ClassRepository['find']>().mockResolvedValue(parent ?? undefined);
  const requirePredefinedSection = vi
    .fn<MasterReferences['requirePredefinedSection']>()
    .mockImplementation((_tx, id) => Promise.resolve({ id, code: 'B', name: 'B' }));
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant } as Awaited<ReturnType<ScopeService['forPrincipal']>>);
  const ownSectionIds = vi
    .fn<TeachingStaff['ownSectionIds']>()
    .mockResolvedValue(new Set(['section-1']));
  const classTeachers = vi
    .fn<TeachingStaff['classTeachers']>()
    .mockResolvedValue(new Map([['section-1', lead]]));
  const countsOf = vi
    .fn<SectionStudents['countsOf']>()
    .mockResolvedValue(new Map([['section-1', 12]]));
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new SectionService(
    { transaction } as unknown as DatabaseService,
    { active, find, viewOf: viewOfFn, insert, update } as unknown as SectionRepository,
    { find: findClass } as unknown as ClassRepository,
    { requirePredefinedSection } as unknown as MasterReferences,
    { requireInstitution, forPrincipal } as unknown as ScopeService,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { ownSectionIds, classTeachers } as unknown as TeachingStaff,
    { countsOf } as unknown as SectionStudents,
    { record } as unknown as AuditService,
  );
  return {
    service,
    ownSectionIds,
    classTeachers,
    countsOf,
    active,
    insert,
    update,
    record,
    findClass,
    requirePredefinedSection,
  };
}

const body = { classId: 'class-1', predefinedSectionId: 'ps-b' };

describe('SectionService', () => {
  describe('list (SEC-01)', () => {
    it('lists the active sections of a class in scope, with no meta', async () => {
      const t = build();
      const result = await t.service.list(owner, 'class-1');
      expect(result.data).toEqual([
        expect.objectContaining({ id: 'section-1', displayName: 'A', currentStudentCount: 12 }),
      ]);
      expect(t.active).toHaveBeenCalledWith(expect.anything(), 'class-1', undefined);
      expect(t.ownSectionIds).not.toHaveBeenCalled();
    });

    it('shows how many students sit in each section, 0 for one with none', async () => {
      const t = build();
      t.active.mockResolvedValue([viewOf(row()), viewOf(row({ id: 'section-2' }))]);
      const result = await t.service.list(owner, 'class-1');
      expect(result.data.map((section) => section.currentStudentCount)).toEqual([12, 0]);
      expect(t.countsOf).toHaveBeenCalledWith(expect.anything(), ['section-1', 'section-2']);
    });

    it('shows the class teacher of the current year on each section, and null for a section with none', async () => {
      const t = build();
      t.active.mockResolvedValue([viewOf(row()), viewOf(row({ id: 'section-2' }))]);
      const result = await t.service.list(owner, 'class-1');
      expect(result.data.map((section) => section.classTeacher)).toEqual([lead, null]);
      expect(t.classTeachers).toHaveBeenCalledWith(expect.anything(), 'inst-1', [
        'section-1',
        'section-2',
      ]);
    });

    it('does not ask who leads when the class has no section', async () => {
      const t = build();
      t.active.mockResolvedValue([]);
      expect((await t.service.list(owner, 'class-1')).data).toEqual([]);
      expect(t.classTeachers).not.toHaveBeenCalled();
    });

    it('shows a teacher only the sections they lead or teach this year', async () => {
      const t = build();
      t.ownSectionIds.mockResolvedValue(new Set(['section-1', 'section-9']));
      const result = await t.service.list(teacher, 'class-1');
      expect(t.ownSectionIds).toHaveBeenCalledWith(expect.anything(), 'teacher-1', 'inst-1');
      expect(t.active).toHaveBeenCalledWith(expect.anything(), 'class-1', [
        'section-1',
        'section-9',
      ]);
      expect(result.data).toHaveLength(1);
    });

    it('is 403 NOT_ASSIGNED for a teacher who has no section of the class, and asks nothing of the database when they have none at all', async () => {
      const none = build();
      none.ownSectionIds.mockResolvedValue(new Set());
      expect(await fail(none.service.list(teacher, 'class-1'))).toMatchObject({
        status: 403,
        code: 'NOT_ASSIGNED',
      });
      expect(none.active).not.toHaveBeenCalled();
      const elsewhere = build();
      elsewhere.active.mockResolvedValue([]);
      expect(await fail(elsewhere.service.list(teacher, 'class-1'))).toMatchObject({
        status: 403,
        code: 'NOT_ASSIGNED',
      });
    });

    it('is 404 for an unknown or deactivated class', async () => {
      expect(await fail(build(row(), null).service.list(owner, 'class-1'))).toMatchObject({
        status: 404,
      });
      expect(
        await fail(build(row(), classRow({ status: 0 })).service.list(owner, 'class-1')),
      ).toMatchObject({ status: 404 });
    });
  });

  describe('create (SEC-02)', () => {
    it('adds the section under the class lock, named after the predefined section, and audits it', async () => {
      const t = build();
      const created = await t.service.create(owner, { ...body, capacity: 35 });
      expect(t.findClass).toHaveBeenLastCalledWith(expect.anything(), 'class-1', true);
      expect(t.insert.mock.calls[0]![1]).toMatchObject({
        society_id: 'society-1',
        institution_id: 'inst-1',
        class_id: 'class-1',
        predefined_section_id: 'ps-b',
        display_name: 'B',
        capacity: 35,
      });
      expect(created).toMatchObject({ classId: 'class-1' });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'section.created',
        societyId: 'society-1',
        institutionId: 'inst-1',
        entityType: 'section',
      });
    });

    it('keeps a name the request gives and no capacity as null', async () => {
      const t = build();
      await t.service.create(owner, { ...body, displayName: 'Rose' });
      expect(t.insert.mock.calls[0]![1]).toMatchObject({ display_name: 'Rose', capacity: null });
    });

    it('is 404 when the class was deactivated meanwhile, and DUPLICATE for a taken section or name', async () => {
      const t = build();
      t.findClass.mockResolvedValueOnce(classRow()).mockResolvedValueOnce(classRow({ status: 0 }));
      expect(await fail(t.service.create(owner, body))).toMatchObject({ status: 404 });
      expect(t.insert).not.toHaveBeenCalled();
      const byPredefined = build();
      byPredefined.insert.mockRejectedValueOnce(unique('uq_sections_class_predefined'));
      expect((await fail(byPredefined.service.create(owner, body))).errors).toEqual([
        expect.objectContaining({ field: 'predefinedSectionId', code: 'DUPLICATE' }),
      ]);
      const byName = build();
      byName.insert.mockRejectedValueOnce(unique('uq_sections_class_name'));
      expect((await fail(byName.service.create(owner, body))).errors).toEqual([
        expect.objectContaining({ field: 'displayName', code: 'DUPLICATE' }),
      ]);
    });
  });

  describe('update (SEC-03)', () => {
    it('checks the version first', async () => {
      const t = build(row({ version: 3 }));
      expect(
        await fail(t.service.update(owner, 'section-1', { version: 2, capacity: 30 })),
      ).toMatchObject({ status: 409 });
      expect(t.update).not.toHaveBeenCalled();
    });

    it('shows the class teacher of the current year on the section it returns', async () => {
      const t = build();
      const saved = await t.service.update(owner, 'section-1', { version: 1, capacity: 30 });
      expect(saved.classTeacher).toEqual(lead);
      expect(t.classTeachers).toHaveBeenCalledWith(expect.anything(), 'inst-1', ['section-1']);
    });

    it('writes nothing when nothing changes', async () => {
      const t = build();
      await t.service.update(owner, 'section-1', { version: 1, displayName: 'A', capacity: 40 });
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('saves the changes, clears the capacity with null and audits before and after', async () => {
      const t = build();
      await t.service.update(owner, 'section-1', {
        version: 1,
        displayName: 'Rose',
        capacity: null,
      });
      expect(t.update.mock.calls[0]![2]).toMatchObject({ display_name: 'Rose', capacity: null });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'section.updated',
        before: expect.objectContaining({ display_name: 'A', capacity: 40 }),
        after: expect.objectContaining({ display_name: 'Rose', capacity: null }),
      });
    });

    it('is 404 for an unknown or deactivated section and DUPLICATE for a taken name', async () => {
      expect(
        await fail(build(null).service.update(owner, 'section-1', { version: 1, capacity: 3 })),
      ).toMatchObject({ status: 404 });
      expect(
        await fail(build(row({ status: 0 })).service.update(owner, 'section-1', { version: 1 })),
      ).toMatchObject({ status: 404 });
      const taken = build();
      taken.update.mockRejectedValueOnce(unique('uq_sections_class_name'));
      expect(
        await fail(taken.service.update(owner, 'section-1', { version: 1, displayName: 'B' })),
      ).toMatchObject({ status: 409, code: 'DUPLICATE' });
    });
  });

  describe('deactivate (SEC-04)', () => {
    it('deactivates the section and audits it', async () => {
      const t = build();
      t.countsOf.mockResolvedValue(new Map());
      expect(await t.service.deactivate(owner, 'section-1')).toEqual({
        id: 'section-1',
        status: 0,
      });
      expect(t.update.mock.calls[0]![2]).toMatchObject({ status: 0 });
      expect(t.record.mock.calls[0]![1]).toMatchObject({ action: 'section.deactivated' });
    });

    it('is refused with 409 HAS_STUDENTS while students sit in it, and writes nothing', async () => {
      const t = build();
      expect(await fail(t.service.deactivate(owner, 'section-1'))).toMatchObject({
        status: 409,
        code: 'HAS_STUDENTS',
      });
      expect(t.countsOf).toHaveBeenCalledWith(expect.anything(), ['section-1']);
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('is 404 for an unknown or already deactivated section', async () => {
      expect(await fail(build(null).service.deactivate(owner, 'section-1'))).toMatchObject({
        status: 404,
      });
      expect(
        await fail(build(row({ status: 0 })).service.deactivate(owner, 'section-1')),
      ).toMatchObject({ status: 404 });
    });
  });
});
