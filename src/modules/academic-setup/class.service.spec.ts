import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { MasterReferences } from '../../platform/masters/index.js';
import type { InstitutionContext, ScopeService } from '../../platform/tenancy/index.js';
import type { ClassRepository, ClassRow, ClassView } from './class.repository.js';
import { ClassService } from './class.service.js';
import type { SectionRepository, SectionRow } from './section.repository.js';
import type { TeachingStaff } from './teaching-staff.js';

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

const row = (overrides: Partial<ClassRow> = {}): ClassRow => ({
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

const viewOf = (base: ClassRow): ClassView => ({
  ...base,
  predefined_code: 'C09',
  predefined_name: '9th',
  category_code: 'HIGH_SCHOOL',
  category_name: 'High School',
  section_count: 0,
});

const section = (overrides: Partial<SectionRow> = {}): SectionRow => ({
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

function build(current: ClassRow | null = row(), offeredIds: string[] = ['cat-hs']) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const active = vi.fn<ClassRepository['active']>().mockResolvedValue([viewOf(row())]);
  const find = vi.fn<ClassRepository['find']>().mockResolvedValue(current ?? undefined);
  const views = vi
    .fn<ClassRepository['views']>()
    .mockImplementation((_tx, ids) =>
      Promise.resolve(ids.map((id) => viewOf(row({ ...current, id })))),
    );
  const offeredCategories = vi
    .fn<ClassRepository['offeredCategories']>()
    .mockResolvedValue(new Set(offeredIds));
  const insert = vi
    .fn<ClassRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(
        row({ ...(values as Partial<ClassRow>), id: `class-${insert.mock.calls.length}` }),
      ),
    );
  const update = vi
    .fn<ClassRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(row({ ...current, ...(changes as Partial<ClassRow>), id, version: 2 })),
    );
  const lockedActive = vi
    .fn<SectionRepository['lockedActive']>()
    .mockResolvedValue([section(), section({ id: 'section-2' })]);
  const sectionUpdate = vi
    .fn<SectionRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(section({ ...(changes as Partial<SectionRow>), id, version: 2 })),
    );
  const requirePredefinedClass = vi
    .fn<MasterReferences['requirePredefinedClass']>()
    .mockImplementation((_tx, id) =>
      Promise.resolve(
        id === 'pc-pu'
          ? {
              id,
              code: 'PUC1',
              name: 'PUC 1st Year',
              categoryId: 'cat-pu',
              categoryCode: 'PRE_UNIVERSITY',
            }
          : { id, code: 'C09', name: '9th', categoryId: 'cat-hs', categoryCode: 'HIGH_SCHOOL' },
      ),
    );
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant } as Awaited<ReturnType<ScopeService['forPrincipal']>>);
  const ownSectionIds = vi
    .fn<TeachingStaff['ownSectionIds']>()
    .mockResolvedValue(new Set(['section-1']));
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new ClassService(
    { transaction } as unknown as DatabaseService,
    { active, find, views, offeredCategories, insert, update } as unknown as ClassRepository,
    { lockedActive, update: sectionUpdate } as unknown as SectionRepository,
    { requirePredefinedClass } as unknown as MasterReferences,
    { requireInstitution, forPrincipal } as unknown as ScopeService,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { ownSectionIds } as unknown as TeachingStaff,
    { record } as unknown as AuditService,
  );
  return {
    service,
    ownSectionIds,
    active,
    find,
    insert,
    update,
    sectionUpdate,
    record,
    requireInstitution,
  };
}

const one = { institutionId: 'inst-1', predefinedClassId: 'pc-9' };

describe('ClassService', () => {
  describe('list (CLS-01)', () => {
    it('lists the active classes of the Institution in scope, with no meta', async () => {
      const t = build();
      const result = await t.service.list(owner, { institutionId: 'inst-1' });
      expect(result.data).toEqual([expect.objectContaining({ id: 'class-1', displayName: '9th' })]);
      expect(t.active).toHaveBeenCalledWith(expect.anything(), 'inst-1');
      expect(t.ownSectionIds).not.toHaveBeenCalled();
    });

    it('shows a teacher only the classes of the sections they lead or teach this year', async () => {
      const t = build();
      t.ownSectionIds.mockResolvedValue(new Set(['section-1', 'section-2']));
      await t.service.list(teacher, { institutionId: 'inst-1' });
      expect(t.ownSectionIds).toHaveBeenCalledWith(expect.anything(), 'teacher-1', 'inst-1');
      expect(t.active).toHaveBeenCalledWith(expect.anything(), 'inst-1', [
        'section-1',
        'section-2',
      ]);
    });

    it('shows a teacher with no section no class, without asking the database', async () => {
      const t = build();
      t.ownSectionIds.mockResolvedValue(new Set());
      expect((await t.service.list(teacher, { institutionId: 'inst-1' })).data).toEqual([]);
      expect(t.active).not.toHaveBeenCalled();
    });
  });

  describe('create (CLS-02)', () => {
    it('adds the class with the predefined name, its category and its audit entry', async () => {
      const t = build();
      const created = await t.service.create(owner, one);
      expect(t.insert.mock.calls[0]![1]).toMatchObject({
        society_id: 'society-1',
        institution_id: 'inst-1',
        predefined_class_id: 'pc-9',
        class_category_id: 'cat-hs',
        stream_name: null,
        display_name: '9th',
        code: null,
      });
      expect(created).toMatchObject({ displayName: '9th' });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'class.created',
        societyId: 'society-1',
        institutionId: 'inst-1',
        entityType: 'class',
      });
    });

    it('names a Pre-University class after its stream, and keeps a name and code the request gives', async () => {
      const t = build(row(), ['cat-pu', 'cat-hs']);
      await t.service.create(owner, { ...one, predefinedClassId: 'pc-pu', streamName: 'PCMC' });
      expect(t.insert.mock.calls[0]![1]).toMatchObject({
        stream_name: 'PCMC',
        display_name: 'PUC 1st Year PCMC',
      });
      await t.service.create(owner, { ...one, displayName: 'Ninth', code: 'IX' });
      expect(t.insert.mock.calls[1]![1]).toMatchObject({ display_name: 'Ninth', code: 'IX' });
    });

    it('is 422 CLASS_NOT_OFFERED for a category the Institution does not offer, before writing', async () => {
      const t = build(row(), ['cat-other']);
      expect(await fail(t.service.create(owner, one))).toMatchObject({
        status: 422,
        code: 'CLASS_NOT_OFFERED',
      });
      expect(t.insert).not.toHaveBeenCalled();
    });

    it('is 422 STREAM_NOT_ALLOWED for a stream outside Pre-University', async () => {
      const t = build();
      expect(await fail(t.service.create(owner, { ...one, streamName: 'Science' }))).toMatchObject({
        status: 422,
        code: 'STREAM_NOT_ALLOWED',
      });
    });

    it('turns the database’s unique answers into DUPLICATE on the field', async () => {
      const byClass = build();
      byClass.insert.mockRejectedValueOnce(unique('uq_classes_institution_class_stream'));
      expect((await fail(byClass.service.create(owner, one))).errors).toEqual([
        expect.objectContaining({ field: 'predefinedClassId', code: 'DUPLICATE' }),
      ]);
      const byName = build();
      byName.insert.mockRejectedValueOnce(unique('uq_classes_institution_name'));
      expect((await fail(byName.service.create(owner, one))).errors).toEqual([
        expect.objectContaining({ field: 'displayName', code: 'DUPLICATE' }),
      ]);
    });
  });

  describe('createMany (CLS-03)', () => {
    it('adds every class in one transaction and answers in the order asked', async () => {
      const t = build();
      const created = await t.service.createMany(owner, {
        institutionId: 'inst-1',
        classes: [
          { predefinedClassId: 'pc-9' },
          { predefinedClassId: 'pc-9', displayName: 'IX B' },
        ],
      });
      expect(created.map((c) => c.id)).toEqual(['class-1', 'class-2']);
      expect(t.record).toHaveBeenCalledTimes(2);
    });

    it('names the item that is refused, and the database’s duplicate inside the request', async () => {
      const refused = build(row(), ['cat-hs']);
      expect(
        (
          await fail(
            refused.service.createMany(owner, {
              institutionId: 'inst-1',
              classes: [
                { predefinedClassId: 'pc-9' },
                { predefinedClassId: 'pc-9', streamName: 'X' },
              ],
            }),
          )
        ).errors,
      ).toEqual([expect.objectContaining({ field: 'classes[1].streamName' })]);
      const twice = build();
      twice.insert.mockRejectedValueOnce(unique('uq_classes_institution_name'));
      expect(
        (
          await fail(
            twice.service.createMany(owner, {
              institutionId: 'inst-1',
              classes: [{ predefinedClassId: 'pc-9' }],
            }),
          )
        ).errors,
      ).toEqual([expect.objectContaining({ field: 'classes[0].displayName', code: 'DUPLICATE' })]);
    });
  });

  describe('update (CLS-04)', () => {
    it('checks the version first', async () => {
      const t = build(row({ version: 3 }));
      expect(
        await fail(t.service.update(owner, 'class-1', { version: 2, displayName: 'x' })),
      ).toMatchObject({ status: 409 });
      expect(t.update).not.toHaveBeenCalled();
    });

    it('writes nothing when nothing changes', async () => {
      const t = build();
      const result = await t.service.update(owner, 'class-1', { version: 1, displayName: '9th' });
      expect(result).toMatchObject({ version: 1 });
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('saves the changes, clears a code with null and audits before and after', async () => {
      const t = build(row({ code: 'IX' }));
      await t.service.update(owner, 'class-1', { version: 1, displayName: 'Ninth', code: null });
      expect(t.update.mock.calls[0]![2]).toMatchObject({ display_name: 'Ninth', code: null });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'class.updated',
        before: expect.objectContaining({ display_name: '9th', code: 'IX' }),
        after: expect.objectContaining({ display_name: 'Ninth', code: null }),
      });
    });

    it('is 404 for an unknown or deactivated class and 409 DUPLICATE for a taken name', async () => {
      expect(
        await fail(build(null).service.update(owner, 'class-1', { version: 1, displayName: 'x' })),
      ).toMatchObject({ status: 404 });
      expect(
        await fail(build(row({ status: 0 })).service.update(owner, 'class-1', { version: 1 })),
      ).toMatchObject({ status: 404 });
      const taken = build();
      taken.update.mockRejectedValueOnce(unique('uq_classes_institution_name'));
      expect(
        await fail(taken.service.update(owner, 'class-1', { version: 1, displayName: 'x' })),
      ).toMatchObject({ status: 409, code: 'DUPLICATE' });
    });
  });

  describe('deactivate (CLS-05)', () => {
    it('deactivates the class and its active sections, auditing each', async () => {
      const t = build();
      expect(await t.service.deactivate(owner, 'class-1')).toEqual({ id: 'class-1', status: 0 });
      expect(t.sectionUpdate.mock.calls.map((call) => [call[1], call[2].status])).toEqual([
        ['section-1', 0],
        ['section-2', 0],
      ]);
      expect(t.record.mock.calls.map((call) => call[1].action)).toEqual([
        'section.deactivated',
        'section.deactivated',
        'class.deactivated',
      ]);
      expect(t.update.mock.calls[0]![2]).toMatchObject({ status: 0 });
    });

    it('is 404 for an unknown or already deactivated class', async () => {
      expect(await fail(build(null).service.deactivate(owner, 'class-1'))).toMatchObject({
        status: 404,
      });
      expect(
        await fail(build(row({ status: 0 })).service.deactivate(owner, 'class-1')),
      ).toMatchObject({ status: 404 });
    });
  });
});
