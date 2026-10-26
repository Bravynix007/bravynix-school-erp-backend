import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../database/index.js';
import type { GrantDirectory, PersonDirectory } from '../identity/index.js';
import type { CreateInstitutionDto, UpdateInstitutionDto } from './institution.dto.js';
import type { InstitutionRepository, InstitutionRow } from './institution.repository.js';
import { INSTITUTION_DEACTIVATED, InstitutionService } from './institution.service.js';
import type { ScopeService } from './scope.service.js';
import type { SocietyRepository, SocietyRow } from './society.repository.js';

const caller = (roleCode: Principal['roleCode'], societyId: string | null = null): Principal => ({
  personId: 'person-1',
  sessionId: 'session-1',
  roleCode,
  societyId,
  clientType: roleCode === 1 ? 'console' : 'mobile',
  viaSupportAccess: false,
});
const superAdmin = caller(1);
const owner = caller(2, 'society-1');

const institution = (overrides: Partial<InstitutionRow> = {}): InstitutionRow => ({
  id: 'inst-1',
  created_at: new Date('2026-10-01T00:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-10-01T00:00:00.000Z'),
  updated_by: 'person-1',
  version: 2,
  status: 1,
  society_id: 'society-1',
  society_name: 'Sunrise',
  name: 'Green Valley',
  code: 'GVS',
  place: 'Old Town',
  board_code: null,
  affiliation_number: null,
  gstin: null,
  email: null,
  country_code: null,
  phone_number: null,
  telephone: null,
  address_line_1: '12 Lake Road',
  address_line_2: null,
  pincode: null,
  latitude: null,
  longitude: null,
  access_paused_at: null,
  access_paused_by: null,
  access_pause_reason: null,
  ...overrides,
});

function build(
  current: InstitutionRow | null = institution(),
  society: Partial<SocietyRow> | null = { status: 1 },
) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<InstitutionRepository['find']>().mockResolvedValue(current ?? undefined);
  const update = vi.fn<InstitutionRepository['update']>().mockResolvedValue();
  const insert = vi.fn<InstitutionRepository['insert']>().mockResolvedValue();
  const activeAmong = vi.fn<InstitutionRepository['activeAmong']>().mockResolvedValue([]);
  const findSociety = vi.fn<SocietyRepository['find']>().mockResolvedValue(society as SocietyRow);
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const endAdminAccessInInstitution = vi
    .fn<GrantDirectory['endAdminAccessInInstitution']>()
    .mockResolvedValue(2);
  const tenant: TenantContext = {
    personId: 'person-1',
    roleCode: 2,
    societyId: 'society-1',
    institutionIds: ['inst-1'],
  };
  const requireInstitution = vi
    .fn<ScopeService['requireInstitution']>()
    .mockResolvedValue({ institutionId: 'inst-1', societyId: 'society-1', tenant });
  const forPrincipal = vi.fn<ScopeService['forPrincipal']>().mockResolvedValue({
    personId: 'person-1',
    roleCode: 2,
    societyId: 'society-1',
    institutions: [{ id: 'inst-1', paused: false }],
    tenant,
  });
  const service = new InstitutionService(
    { transaction } as unknown as DatabaseService,
    { find, update, insert, activeAmong } as unknown as InstitutionRepository,
    { find: findSociety } as unknown as SocietyRepository,
    { requireInstitution, forPrincipal } as unknown as ScopeService,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { endAdminAccessInInstitution } as unknown as GrantDirectory,
    { record } as unknown as AuditService,
    new FixedClock('2026-10-26T10:00:00.000Z'),
  );
  return {
    service,
    transaction,
    find,
    update,
    insert,
    activeAmong,
    record,
    endAdminAccessInInstitution,
    requireInstitution,
    forPrincipal,
    tx,
    tenant,
  };
}

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const patch = (body: Partial<UpdateInstitutionDto> & { version: number }) =>
  body as UpdateInstitutionDto;
const creation = (body: Partial<CreateInstitutionDto> = {}) =>
  ({ name: 'X', code: 'x', address: { line1: 'a' }, ...body }) as CreateInstitutionDto;

describe('InstitutionService', () => {
  describe('create: which Society', () => {
    it('needs Super Admin to name it', async () => {
      const t = build();
      const error = await refusal(t.service.create(superAdmin, creation()));
      expect(error.options.errors).toEqual([
        expect.objectContaining({ field: 'societyId', code: 'REQUIRED' }),
      ]);
      expect(t.transaction).not.toHaveBeenCalled();
    });

    it('does not let an Owner name one, not even their own', async () => {
      const t = build();
      const error = await refusal(t.service.create(owner, creation({ societyId: 'society-1' })));
      expect(error.options.errors).toEqual([
        expect.objectContaining({ field: 'societyId', code: 'FIELD_NOT_ALLOWED' }),
      ]);
    });

    it('uses an Owner’s own Society, in a context that names the new Institution', async () => {
      const t = build();
      await t.service.create(owner, creation());
      const [, values] = t.insert.mock.calls[0]!;
      expect(values).toMatchObject({
        society_id: 'society-1',
        name: 'X',
        code: 'x',
        address_line_1: 'a',
        created_by: 'person-1',
        updated_by: 'person-1',
      });
      expect(t.transaction.mock.calls[0]![0]).toEqual({
        personId: 'person-1',
        roleCode: 2,
        societyId: 'society-1',
        institutionIds: [values.id],
      });
    });

    it('opens Super Admin’s context in the named Society', async () => {
      const t = build();
      await t.service.create(superAdmin, creation({ societyId: 'society-9' }));
      expect(t.transaction.mock.calls[0]![0]).toMatchObject({
        roleCode: 1,
        societyId: 'society-9',
      });
    });

    it('answers 404 for a Society that is not there and 409 for a deactivated one', async () => {
      const none = build(institution(), null);
      expect(
        (await refusal(none.service.create(superAdmin, creation({ societyId: 's' })))).status,
      ).toBe(404);
      const gone = build(institution(), { status: 0 });
      const error = await refusal(gone.service.create(superAdmin, creation({ societyId: 's' })));
      expect(error).toMatchObject({ status: 409, code: 'INVALID_STATE' });
      expect(gone.insert).not.toHaveBeenCalled();
    });

    it('maps a taken code to 409 DUPLICATE on the code field, and lets other errors through', async () => {
      const t = build();
      t.insert.mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), {
          code: '23505',
          constraint: 'uq_institutions_society_code',
        }),
      );
      const error = await refusal(t.service.create(owner, creation()));
      expect(error).toMatchObject({ status: 409, code: 'DUPLICATE' });
      const failure = Object.assign(new Error('boom'), { code: '23505', constraint: 'uq_other' });
      t.insert.mockRejectedValueOnce(failure);
      await expect(t.service.create(owner, creation())).rejects.toBe(failure);
    });

    it('stores a location as exact 6-decimal text', async () => {
      const t = build();
      await t.service.create(
        owner,
        creation({ location: { latitude: 12.5, longitude: -77.123456 } }),
      );
      expect(t.insert.mock.calls[0]![1]).toMatchObject({
        latitude: '12.500000',
        longitude: '-77.123456',
      });
    });
  });

  describe('which context a change runs in', () => {
    it('gives an Owner the context of the scope check, so a stranger’s Institution is 404 and a paused one 423', async () => {
      const t = build();
      t.requireInstitution.mockRejectedValueOnce(AppException.notFound());
      expect((await refusal(t.service.update(owner, 'inst-9', patch({ version: 1 })))).status).toBe(
        404,
      );
      t.requireInstitution.mockRejectedValueOnce(AppException.paused());
      expect((await refusal(t.service.deactivate(owner, 'inst-1'))).status).toBe(423);
      await t.service.update(owner, 'inst-1', patch({ version: 2, name: 'New' }));
      expect(t.transaction).toHaveBeenLastCalledWith(t.tenant, expect.any(Function));
    });

    it('gives Super Admin the Society and Institution it found', async () => {
      const t = build(institution({ society_id: 'society-7' }));
      await t.service.update(superAdmin, 'inst-1', patch({ version: 2, name: 'New' }));
      expect(t.requireInstitution).not.toHaveBeenCalled();
      expect(t.transaction).toHaveBeenLastCalledWith(
        { personId: 'person-1', roleCode: 1, societyId: 'society-7', institutionIds: ['inst-1'] },
        expect.any(Function),
      );
    });

    it('answers 404 to Super Admin for an Institution that is not there', async () => {
      const t = build(null);
      expect((await refusal(t.service.deactivate(superAdmin, 'inst-1'))).status).toBe(404);
    });
  });

  describe('update', () => {
    it('refuses a stale version first, then a deactivated Institution', async () => {
      const stale = build(institution({ status: 0, version: 5 }));
      const error = await refusal(
        stale.service.update(superAdmin, 'inst-1', patch({ version: 2, name: 'x' })),
      );
      expect(error.code).toBe('VERSION_CONFLICT');
      const gone = build(institution({ status: 0 }));
      const inactive = await refusal(
        gone.service.update(superAdmin, 'inst-1', patch({ version: 2, name: 'x' })),
      );
      expect(inactive).toMatchObject({ status: 409, code: 'INVALID_STATE' });
    });

    it('writes nothing, and keeps the version, when the request changes nothing', async () => {
      const t = build();
      const result = await t.service.update(
        superAdmin,
        'inst-1',
        patch({
          version: 2,
          name: 'Green Valley',
          place: 'Old Town',
          address: { line1: '12 Lake Road' },
        }),
      );
      expect(result.version).toBe(2);
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('writes only what differs, stamps the author and audits before and after', async () => {
      const t = build();
      t.find
        .mockResolvedValueOnce(institution())
        .mockResolvedValueOnce(institution({ version: 3, name: 'New' }));
      await t.service.update(
        owner,
        'inst-1',
        patch({ version: 2, name: 'New', place: 'Old Town', boardCode: 3 }),
      );
      expect(t.update).toHaveBeenCalledWith(t.tx, 'inst-1', {
        name: 'New',
        board_code: 3,
        updated_by: 'person-1',
      });
      expect(t.record).toHaveBeenCalledWith(
        t.tx,
        expect.objectContaining({
          action: 'institution.update',
          societyId: 'society-1',
          institutionId: 'inst-1',
          entityType: 'institution',
          before: expect.objectContaining({ name: 'Green Valley' }),
          after: expect.objectContaining({ name: 'New' }),
        }),
      );
    });

    it('clears the location whole with null', async () => {
      const t = build(institution({ latitude: '1.000000', longitude: '2.000000' }));
      await t.service.update(owner, 'inst-1', patch({ version: 2, location: null }));
      expect(t.update).toHaveBeenCalledWith(t.tx, 'inst-1', {
        latitude: null,
        longitude: null,
        updated_by: 'person-1',
      });
    });
  });

  describe('deactivate', () => {
    it('ends the Admin grants in the same transaction and audits how many', async () => {
      const t = build();
      await expect(t.service.deactivate(owner, 'inst-1')).resolves.toEqual({
        id: 'inst-1',
        status: 0,
      });
      expect(t.update).toHaveBeenCalledWith(t.tx, 'inst-1', { status: 0, updated_by: 'person-1' });
      expect(t.endAdminAccessInInstitution).toHaveBeenCalledWith(
        t.tx,
        'inst-1',
        'person-1',
        INSTITUTION_DEACTIVATED,
        new Date('2026-10-26T10:00:00.000Z'),
      );
      expect(t.record).toHaveBeenCalledWith(
        t.tx,
        expect.objectContaining({
          action: 'institution.deactivate',
          before: { status: 1 },
          after: { status: 0, grantsRevoked: 2 },
        }),
      );
    });

    it('refuses an Institution that is already deactivated, without touching grants', async () => {
      const t = build(institution({ status: 0 }));
      expect((await refusal(t.service.deactivate(superAdmin, 'inst-1'))).code).toBe(
        'INVALID_STATE',
      );
      expect(t.endAdminAccessInInstitution).not.toHaveBeenCalled();
    });
  });

  describe('pause and resume', () => {
    const pausedRow = institution({
      access_paused_at: new Date(),
      access_paused_by: 'a',
      access_pause_reason: 'x',
    });

    it('pauses with the time, the person and the reason, and audits the reason', async () => {
      const t = build();
      await t.service.pause(superAdmin, 'inst-1', { version: 2, reason: 'Dues' });
      expect(t.update).toHaveBeenCalledWith(t.tx, 'inst-1', {
        access_paused_at: new Date('2026-10-26T10:00:00.000Z'),
        access_paused_by: 'person-1',
        access_pause_reason: 'Dues',
        updated_by: 'person-1',
      });
      expect(t.record).toHaveBeenCalledWith(
        t.tx,
        expect.objectContaining({
          action: 'access.pause',
          reason: 'Dues',
          institutionId: 'inst-1',
        }),
      );
    });

    it('refuses to pause a paused or deactivated Institution, and to resume one that is not paused or is deactivated', async () => {
      for (const [row, run] of [
        [
          pausedRow,
          (s: InstitutionService) => s.pause(superAdmin, 'inst-1', { version: 2, reason: 'r' }),
        ],
        [
          institution({ status: 0 }),
          (s: InstitutionService) => s.pause(superAdmin, 'inst-1', { version: 2, reason: 'r' }),
        ],
        [institution(), (s: InstitutionService) => s.resume(superAdmin, 'inst-1', { version: 2 })],
        [
          institution({ ...pausedRow, status: 0 }),
          (s: InstitutionService) => s.resume(superAdmin, 'inst-1', { version: 2 }),
        ],
      ] as const) {
        const t = build(row);
        expect((await refusal(run(t.service))).code).toBe('INVALID_STATE');
        expect(t.update).not.toHaveBeenCalled();
      }
    });

    it('resumes a paused Institution, clearing the three columns together', async () => {
      const t = build(pausedRow);
      await t.service.resume(superAdmin, 'inst-1', { version: 2 });
      expect(t.update).toHaveBeenCalledWith(t.tx, 'inst-1', {
        access_paused_at: null,
        access_paused_by: null,
        access_pause_reason: null,
        updated_by: 'person-1',
      });
      expect(t.record).toHaveBeenCalledWith(
        t.tx,
        expect.objectContaining({ action: 'access.resume' }),
      );
    });
  });

  describe('options (INS-01)', () => {
    it('asks for the Institutions in the caller’s scope, in the caller’s context', async () => {
      const t = build();
      const result = await t.service.options(owner);
      expect(t.activeAmong).toHaveBeenCalledWith(t.tx, 'society-1', ['inst-1']);
      expect(result.data).toEqual([]);
      expect(result.options.meta).toBeNull();
    });

    it('answers an empty list, with no query, to a caller with no Society', async () => {
      const t = build();
      t.forPrincipal.mockResolvedValueOnce({
        personId: 'person-1',
        roleCode: 4,
        societyId: null,
        institutions: [],
        tenant: {},
      });
      const result = await t.service.options(caller(4));
      expect(result.data).toEqual([]);
      expect(t.transaction).not.toHaveBeenCalled();
    });
  });
});
