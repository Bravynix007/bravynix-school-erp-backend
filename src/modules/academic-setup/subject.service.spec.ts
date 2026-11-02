import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { SubjectRepository, SubjectRow } from './subject.repository.js';
import { SubjectService } from './subject.service.js';

const owner = {
  personId: 'owner-1',
  sessionId: 'session-1',
  roleCode: 2,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
} as Principal;

const subject = (overrides: Partial<SubjectRow> = {}): SubjectRow => ({
  id: 'subject-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'owner-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'owner-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  name: 'Mathematics',
  code: 'MAT',
  ...overrides,
});

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

const unique = (constraint: string) =>
  Object.assign(new Error('unique'), { code: '23505', constraint });

function build(current: SubjectRow | null = subject()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const active = vi.fn<SubjectRepository['active']>().mockResolvedValue([subject()]);
  const find = vi.fn<SubjectRepository['find']>().mockResolvedValue(current ?? undefined);
  const insert = vi
    .fn<SubjectRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(subject({ ...(values as Partial<SubjectRow>), id: 'subject-new' })),
    );
  const update = vi
    .fn<SubjectRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(subject({ ...current, ...(changes as Partial<SubjectRow>), id, version: 2 })),
    );
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new SubjectService(
    { transaction } as unknown as DatabaseService,
    { active, find, insert, update } as unknown as SubjectRepository,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
  );
  return { service, active, find, insert, update, record };
}

describe('SubjectService', () => {
  it('refuses a caller with no Society before touching the database', async () => {
    const t = build();
    const nobody = { ...owner, societyId: null } as Principal;
    expect(await fail(t.service.list(nobody))).toMatchObject({ status: 403 });
    expect(t.active).not.toHaveBeenCalled();
  });

  describe('list (SUB-01)', () => {
    it('lists the active subjects of the caller’s Society, with no meta', async () => {
      const t = build();
      const result = await t.service.list(owner);
      expect(result.data).toEqual([
        expect.objectContaining({ id: 'subject-1', name: 'Mathematics' }),
      ]);
      expect(t.active).toHaveBeenCalledWith(expect.anything(), 'society-1');
    });
  });

  describe('create (SUB-02)', () => {
    it('adds the subject to the caller’s Society and audits it without an Institution', async () => {
      const t = build();
      const created = await t.service.create(owner, { name: 'Science' });
      expect(t.insert.mock.calls[0]![1]).toMatchObject({
        society_id: 'society-1',
        name: 'Science',
        code: null,
      });
      expect(created).toMatchObject({ name: 'Science' });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'subject.created',
        societyId: 'society-1',
        institutionId: null,
        entityType: 'subject',
      });
    });

    it('turns the name and code indexes into 409 DUPLICATE', async () => {
      const byName = build();
      byName.insert.mockRejectedValueOnce(unique('uq_subjects_society_name'));
      expect(await fail(byName.service.create(owner, { name: 'Science' }))).toMatchObject({
        status: 409,
        code: 'DUPLICATE',
      });
      const byCode = build();
      byCode.insert.mockRejectedValueOnce(unique('uq_subjects_society_code'));
      expect(
        await fail(byCode.service.create(owner, { name: 'Science', code: 'MAT' })),
      ).toMatchObject({ status: 409, code: 'DUPLICATE' });
    });
  });

  describe('update (SUB-03)', () => {
    it('checks the version first', async () => {
      const t = build(subject({ version: 3 }));
      expect(
        await fail(t.service.update(owner, 'subject-1', { version: 2, name: 'x' })),
      ).toMatchObject({ status: 409 });
      expect(t.update).not.toHaveBeenCalled();
    });

    it('writes nothing when nothing changes', async () => {
      const t = build();
      const result = await t.service.update(owner, 'subject-1', {
        version: 1,
        name: 'Mathematics',
      });
      expect(result).toMatchObject({ version: 1 });
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('saves the changes, clears a code with null, and audits before and after', async () => {
      const t = build();
      await t.service.update(owner, 'subject-1', { version: 1, name: 'Maths', code: null });
      expect(t.update.mock.calls[0]![2]).toMatchObject({ name: 'Maths', code: null });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'subject.updated',
        before: expect.objectContaining({ name: 'Mathematics', code: 'MAT' }),
        after: expect.objectContaining({ name: 'Maths', code: null }),
      });
    });

    it('is 404 for an unknown or deactivated subject, and 409 DUPLICATE for a taken name', async () => {
      expect(
        await fail(build(null).service.update(owner, 'subject-1', { version: 1, name: 'x' })),
      ).toMatchObject({ status: 404 });
      expect(
        await fail(
          build(subject({ status: 0 })).service.update(owner, 'subject-1', { version: 1 }),
        ),
      ).toMatchObject({ status: 404 });
      const taken = build();
      taken.update.mockRejectedValueOnce(unique('uq_subjects_society_name'));
      expect(
        await fail(taken.service.update(owner, 'subject-1', { version: 1, name: 'Science' })),
      ).toMatchObject({ status: 409, code: 'DUPLICATE' });
    });
  });

  describe('deactivate (SUB-04)', () => {
    it('deactivates the subject and audits it', async () => {
      const t = build();
      expect(await t.service.deactivate(owner, 'subject-1')).toEqual({
        id: 'subject-1',
        status: 0,
      });
      expect(t.update.mock.calls[0]![2]).toMatchObject({ status: 0 });
      expect(t.record.mock.calls[0]![1]).toMatchObject({ action: 'subject.deactivated' });
    });

    it('is 404 when the subject is unknown or already deactivated', async () => {
      expect(await fail(build(null).service.deactivate(owner, 'subject-1'))).toMatchObject({
        status: 404,
      });
      expect(
        await fail(build(subject({ status: 0 })).service.deactivate(owner, 'subject-1')),
      ).toMatchObject({ status: 404 });
    });
  });
});
