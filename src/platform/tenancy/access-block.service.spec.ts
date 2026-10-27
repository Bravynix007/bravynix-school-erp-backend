import type { Principal } from '../../common/auth/access-token-verifier.js';
import { BlockSection } from '../../common/auth/block-section.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../database/index.js';
import type { PersonDirectory } from '../identity/index.js';
import type { CreateAccessBlockDto } from './access-block.dto.js';
import type { AccessBlockRepository, AccessBlockRow } from './access-block.repository.js';
import { AccessBlockService } from './access-block.service.js';
import type { InstitutionRepository, InstitutionRow } from './institution.repository.js';
import type { RequestScope, ScopeService } from './scope.service.js';
import type { SocietyRepository, SocietyRow } from './society.repository.js';

const admin = { personId: 'admin-1', roleCode: 1, societyId: null } as unknown as Principal;
const owner = { personId: 'owner-1', roleCode: 2, societyId: 'society-1' } as unknown as Principal;
const tx = {} as Tx;
const now = '2026-10-27T10:00:00.000Z';

const block = (overrides: Partial<AccessBlockRow> = {}): AccessBlockRow => ({
  id: 'block-1',
  created_at: new Date(now),
  created_by: 'admin-1',
  updated_at: new Date(now),
  updated_by: 'admin-1',
  society_id: 'society-1',
  institution_id: null,
  section: BlockSection.Owners,
  reason: 'Dues',
  lifted_at: null,
  lifted_by: null,
  ...overrides,
});

function build(
  options: {
    society?: Partial<SocietyRow> | null;
    institution?: Partial<InstitutionRow> | null;
  } = {},
) {
  const society = options.society === undefined ? { status: 1 } : options.society;
  const institution =
    options.institution === undefined
      ? { status: 1, society_id: 'society-1' }
      : options.institution;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const insert = vi
    .fn<AccessBlockRepository['insert']>()
    .mockImplementation((_tx, values) => Promise.resolve(block(values as Partial<AccessBlockRow>)));
  const find = vi.fn<AccessBlockRepository['find']>().mockResolvedValue(block());
  const lift = vi
    .fn<AccessBlockRepository['lift']>()
    .mockResolvedValue(block({ lifted_at: new Date(now), lifted_by: 'admin-1' }));
  const page = vi
    .fn<AccessBlockRepository['page']>()
    .mockResolvedValue({ rows: [block()], total: 1 });
  const activeIn = vi.fn<AccessBlockRepository['activeIn']>().mockResolvedValue([]);
  const findSociety = vi.fn<SocietyRepository['find']>().mockResolvedValue(society as SocietyRow);
  const findInstitution = vi
    .fn<InstitutionRepository['find']>()
    .mockResolvedValue((institution ?? undefined) as InstitutionRow | undefined);
  const ownTenant: TenantContext = { personId: 'owner-1', roleCode: 2, societyId: 'society-1' };
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ societyId: 'society-1', tenant: ownTenant } as unknown as RequestScope);
  const describe = vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map());
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new AccessBlockService(
    { transaction } as unknown as DatabaseService,
    { insert, find, lift, page, activeIn } as unknown as AccessBlockRepository,
    { find: findSociety } as unknown as SocietyRepository,
    { find: findInstitution } as unknown as InstitutionRepository,
    { forPrincipal } as unknown as ScopeService,
    { describe } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
    new FixedClock(now),
  );
  return { service, transaction, insert, find, lift, page, activeIn, record, ownTenant };
}

const dto = (body: Partial<CreateAccessBlockDto>) =>
  ({ section: 'owners', societyId: 'society-1', reason: 'Dues', ...body }) as CreateAccessBlockDto;

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('AccessBlockService.block (PLT-42)', () => {
  it('blocks the Owners of a Society in that Society’s context and audits it there', async () => {
    const t = build();
    const resource = await t.service.block(admin, dto({}));
    expect(t.transaction.mock.calls[0]![0]).toMatchObject({
      roleCode: 1,
      societyId: 'society-1',
      institutionIds: [],
    });
    expect(t.insert).toHaveBeenCalledWith(tx, {
      society_id: 'society-1',
      institution_id: null,
      section: BlockSection.Owners,
      reason: 'Dues',
      created_by: 'admin-1',
      updated_by: 'admin-1',
    });
    expect(t.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'access.block',
        societyId: 'society-1',
        institutionId: null,
        reason: 'Dues',
        entityType: 'access_block',
      }),
    );
    expect(resource).toMatchObject({ section: 'owners', institutionId: null, reason: 'Dues' });
  });

  it('runs a staff or students block in a context that names the Institution, so the audit row is admitted', async () => {
    const t = build();
    await t.service.block(admin, dto({ section: 'staff', institutionId: 'inst-1' }));
    expect(t.transaction.mock.calls[0]![0]).toMatchObject({ institutionIds: ['inst-1'] });
    expect(t.insert.mock.calls[0]![1]).toMatchObject({
      institution_id: 'inst-1',
      section: BlockSection.Staff,
    });
    expect(t.record).toHaveBeenCalledWith(tx, expect.objectContaining({ institutionId: 'inst-1' }));
  });

  it('keeps an Institution out of an owners block, and requires one for staff and students', async () => {
    const t = build();
    expect(
      (await refusal(t.service.block(admin, dto({ institutionId: 'inst-1' })))).options.errors,
    ).toEqual([expect.objectContaining({ field: 'institutionId', code: 'FIELD_NOT_ALLOWED' })]);
    for (const section of ['staff', 'students'] as const) {
      expect((await refusal(t.service.block(admin, dto({ section })))).options.errors).toEqual([
        expect.objectContaining({ field: 'institutionId', code: 'REQUIRED' }),
      ]);
      // A JSON null passes `@IsOptional`, and must not reach the database's scope check.
      expect(
        (await refusal(t.service.block(admin, dto({ section, institutionId: null })))).options
          .errors,
      ).toEqual([expect.objectContaining({ field: 'institutionId', code: 'REQUIRED' })]);
    }
    expect(t.transaction).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown Society, and for an Institution that is missing or of another Society', async () => {
    expect((await refusal(build({ society: null }).service.block(admin, dto({})))).status).toBe(
      404,
    );
    for (const institution of [null, { status: 1, society_id: 'society-2' }]) {
      const t = build({ institution });
      const error = await refusal(
        t.service.block(admin, dto({ section: 'students', institutionId: 'inst-1' })),
      );
      expect(error.status).toBe(404);
      expect(t.insert).not.toHaveBeenCalled();
    }
  });

  it('answers 409 INVALID_STATE for a deactivated Society or Institution', async () => {
    const gone = await refusal(build({ society: { status: 0 } }).service.block(admin, dto({})));
    expect(gone).toMatchObject({ status: 409, code: 'INVALID_STATE' });
    const off = await refusal(
      build({ institution: { status: 0, society_id: 'society-1' } }).service.block(
        admin,
        dto({ section: 'staff', institutionId: 'inst-1' }),
      ),
    );
    expect(off).toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('maps the active-block index to 409 DUPLICATE on the section, and lets other errors through', async () => {
    const t = build();
    t.insert.mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), {
        code: '23505',
        constraint: 'uq_access_blocks_active',
      }),
    );
    const error = await refusal(t.service.block(admin, dto({})));
    expect(error).toMatchObject({ status: 409, code: 'DUPLICATE' });
    expect(error.options.errors).toEqual([expect.objectContaining({ field: 'section' })]);
    const failure = Object.assign(new Error('boom'), { code: '23505', constraint: 'uq_other' });
    t.insert.mockRejectedValueOnce(failure);
    await expect(t.service.block(admin, dto({}))).rejects.toBe(failure);
  });

  it('is for Super Admin only, whatever the route guard did', async () => {
    const error = await refusal(build().service.block(owner, dto({})));
    expect(error.status).toBe(403);
  });
});

describe('AccessBlockService.lift (PLT-43)', () => {
  it('lifts with one conditional write in the block’s own context and audits before and after', async () => {
    const t = build();
    const staff = { section: BlockSection.Staff, institution_id: 'inst-1' };
    t.find.mockResolvedValue(block(staff));
    t.lift.mockResolvedValue(block({ ...staff, lifted_at: new Date(now), lifted_by: 'admin-1' }));
    await expect(t.service.lift(admin, 'block-1')).resolves.toEqual({ id: 'block-1', status: 0 });
    expect(t.lift).toHaveBeenCalledWith(tx, 'block-1', 'admin-1', new Date(now));
    expect(t.transaction.mock.calls[1]![0]).toMatchObject({
      societyId: 'society-1',
      institutionIds: ['inst-1'],
    });
    expect(t.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'access.unblock',
        institutionId: 'inst-1',
        before: expect.objectContaining({ active: true }),
        after: expect.objectContaining({ active: false }),
      }),
    );
  });

  it('answers 404 for an unknown block', async () => {
    const t = build();
    t.find.mockResolvedValue(undefined);
    expect((await refusal(t.service.lift(admin, 'nope'))).status).toBe(404);
    expect(t.lift).not.toHaveBeenCalled();
  });

  it('answers 404, and writes no audit entry, when another lift got there first', async () => {
    const t = build();
    t.lift.mockResolvedValue(undefined);
    expect((await refusal(t.service.lift(admin, 'block-1'))).status).toBe(404);
    expect(t.record).not.toHaveBeenCalled();
  });
});

const query = (overrides: object = {}) =>
  ({ page: 2, limit: 10, ...overrides }) as Parameters<AccessBlockService['list']>[1];

describe('AccessBlockService.list (PLT-44)', () => {
  it('pages the active blocks, newest first, and maps section names to codes', async () => {
    const t = build();
    const result = await t.service.list(
      admin,
      query({ societyId: 'society-1', section: ['staff', 'students'] }),
    );
    expect(t.page).toHaveBeenCalledWith(
      tx,
      {
        q: undefined,
        societyId: 'society-1',
        institutionId: undefined,
        sections: [BlockSection.Staff, BlockSection.Students],
      },
      [{ field: 'blockedAt', direction: 'desc' }],
      10,
      10,
    );
    expect(result.data).toHaveLength(1);
    expect(result.options.meta).toMatchObject({ page: 2, limit: 10, totalItems: 1 });
  });

  it('refuses a sort field the list does not offer', async () => {
    const error = await refusal(build().service.list(admin, query({ sort: 'reason' })));
    expect(error).toMatchObject({ status: 400, code: 'INVALID_SORT' });
  });
});

describe('AccessBlockService.forSociety (SOC-02)', () => {
  it('reads the blocks of the Owner’s own Society in the Owner’s context', async () => {
    const t = build();
    t.activeIn.mockResolvedValue([
      {
        ...block({ section: BlockSection.Staff, institution_id: 'inst-1' }),
        institution_name: 'Green Valley',
      },
    ]);
    const result = await t.service.forSociety(owner);
    expect(t.transaction).toHaveBeenCalledWith(t.ownTenant, expect.any(Function));
    expect(t.activeIn).toHaveBeenCalledWith(tx, 'society-1');
    expect(result.data).toEqual([
      {
        id: 'block-1',
        section: 'staff',
        institutionId: 'inst-1',
        institutionName: 'Green Valley',
        reason: 'Dues',
        blockedAt: now,
      },
    ]);
    expect(result.options.meta).toBeNull();
  });

  it('refuses a caller with no Society', async () => {
    const t = build();
    vi.mocked(t.service['scope'].forPrincipal).mockResolvedValue({
      societyId: null,
    } as unknown as RequestScope);
    expect((await refusal(t.service.forSociety(owner))).status).toBe(403);
  });
});
