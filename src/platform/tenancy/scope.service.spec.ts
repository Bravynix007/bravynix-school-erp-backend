import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { GrantDirectory } from '../identity/index.js';
import { ScopeService } from './scope.service.js';
import { BlockSection } from '../../common/auth/block-section.js';
import type { ActiveBlock } from './access-block.rules.js';
import type { TenancyRepository } from './tenancy.repository.js';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  personId: 'person-1',
  sessionId: 'session-1',
  roleCode: 2,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
  ...overrides,
});

function build(institutions: string[] = [], granted: string[] = [], blocks: ActiveBlock[] = []) {
  const activeInstitutionIds = vi
    .fn<TenancyRepository['activeInstitutionIds']>()
    .mockResolvedValue(institutions);
  const activeBlocks = vi.fn<TenancyRepository['activeBlocks']>().mockResolvedValue(blocks);
  const adminInstitutionIds = vi
    .fn<GrantDirectory['adminInstitutionIds']>()
    .mockResolvedValue(granted);
  const service = new ScopeService(
    { activeInstitutionIds, activeBlocks } as unknown as TenancyRepository,
    { adminInstitutionIds } as unknown as GrantDirectory,
  );
  return { service, activeInstitutionIds, activeBlocks, adminInstitutionIds };
}

const staffOfA2: ActiveBlock = { section: BlockSection.Staff, institutionId: 'a2' };
const owners: ActiveBlock = { section: BlockSection.Owners, institutionId: null };

async function status(work: () => unknown): Promise<number | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof AppException ? error.status : -1;
  }
}

describe('ScopeService.forPrincipal', () => {
  it('gives a Society Owner every active Institution of the Society', async () => {
    const t = build(['a1', 'a2']);
    const scope = await t.service.forPrincipal(principal());
    expect(scope.institutions).toEqual([
      { id: 'a1', staffBlocked: false },
      { id: 'a2', staffBlocked: false },
    ]);
    expect(t.activeInstitutionIds).toHaveBeenCalledWith(
      { personId: 'person-1', roleCode: 2, societyId: 'society-1' },
      'society-1',
      null,
    );
    expect(t.adminInstitutionIds).not.toHaveBeenCalled();
  });

  it('gives an Institution Admin only the Institutions they hold a grant for', async () => {
    const t = build(['a1'], ['a1']);
    const scope = await t.service.forPrincipal(principal({ roleCode: 3 }));
    expect(scope.institutions).toEqual([{ id: 'a1', staffBlocked: false }]);
    expect(t.adminInstitutionIds).toHaveBeenCalledWith('person-1', 'society-1');
    expect(t.activeInstitutionIds).toHaveBeenCalledWith(expect.anything(), 'society-1', ['a1']);
  });

  it.each([
    ['a teacher', principal({ roleCode: 4 })],
    ['a parent', principal({ roleCode: 5, societyId: null })],
    ['Super Admin', principal({ roleCode: 1, societyId: null })],
    ['a session with no context', principal({ roleCode: null, societyId: null })],
    ['an owner with no Society', principal({ societyId: null })],
  ])('reaches no Institution for %s, and reads nothing', async (_who, caller) => {
    const t = build(['a1']);
    expect((await t.service.forPrincipal(caller)).institutions).toEqual([]);
    expect(t.activeInstitutionIds).not.toHaveBeenCalled();
    expect(t.adminInstitutionIds).not.toHaveBeenCalled();
  });

  it('builds the Society-wide transaction scope from the Institutions in reach', async () => {
    const scope = await build(['a1', 'a2']).service.forPrincipal(principal());
    expect(scope.tenant).toEqual({
      personId: 'person-1',
      roleCode: 2,
      societyId: 'society-1',
      institutionIds: ['a1', 'a2'],
    });
  });

  it("leaves staff-blocked Institutions out of an Institution Admin's Society-wide scope, not an Owner's", async () => {
    const admin = await build(['a1', 'a2'], ['a1', 'a2'], [staffOfA2]).service.forPrincipal(
      principal({ roleCode: 3 }),
    );
    expect(admin.tenant.institutionIds).toEqual(['a1']);
    expect(admin.institutions).toEqual([
      { id: 'a1', staffBlocked: false },
      { id: 'a2', staffBlocked: true },
    ]);
    const owner = await build(['a1', 'a2'], [], [staffOfA2]).service.forPrincipal(principal());
    expect(owner.tenant.institutionIds).toEqual(['a1', 'a2']);
  });

  it('reads the blocks of the Society once per request, for the gate and the scope together', async () => {
    const t = build(['a1'], [], [owners]);
    const caller = principal();
    await Promise.all([t.service.activeBlocks(caller), t.service.forPrincipal(caller)]);
    expect(t.activeBlocks).toHaveBeenCalledTimes(1);
    expect(t.activeBlocks).toHaveBeenCalledWith('society-1', 'person-1');
  });

  it('reads no blocks for a caller with no Society', async () => {
    const t = build(['a1'], [], [owners]);
    expect(await t.service.activeBlocks(principal({ roleCode: 1, societyId: null }))).toEqual([]);
    expect(t.activeBlocks).not.toHaveBeenCalled();
  });

  it('resolves once per request and again for the next one', async () => {
    const t = build(['a1']);
    const caller = principal();
    await Promise.all([t.service.forPrincipal(caller), t.service.forPrincipal(caller)]);
    await t.service.forPrincipal(caller);
    expect(t.activeInstitutionIds).toHaveBeenCalledTimes(1);
    await t.service.forPrincipal(principal());
    expect(t.activeInstitutionIds).toHaveBeenCalledTimes(2);
  });
});

describe('ScopeService.requireInstitution', () => {
  it('opens a transaction scope narrowed to the one Institution', async () => {
    const context = await build(['a1', 'a2']).service.requireInstitution(principal(), 'a1');
    expect(context).toEqual({
      institutionId: 'a1',
      societyId: 'society-1',
      tenant: {
        personId: 'person-1',
        roleCode: 2,
        societyId: 'society-1',
        institutionIds: ['a1'],
      },
    });
  });

  it('answers 404 for an Institution outside the scope, whatever the reason', async () => {
    const t = build(['a1']);
    expect(await status(() => t.service.requireInstitution(principal(), 'elsewhere'))).toBe(404);
    expect(await status(() => t.service.requireInstitution(principal({ roleCode: 4 }), 'a1'))).toBe(
      404,
    );
  });

  it('answers 423 SECTION_BLOCKED to an Institution Admin for an Institution whose staff are blocked', async () => {
    const t = build(['a1', 'a2'], ['a1', 'a2'], [staffOfA2]);
    const admin = principal({ roleCode: 3 });
    const error = await t.service.requireInstitution(admin, 'a2').catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 423,
      code: 'SECTION_BLOCKED',
      options: { details: { section: 'staff' } },
    });
    expect(await t.service.requireInstitution(admin, 'a1')).toMatchObject({ institutionId: 'a1' });
  });

  it('does not stop the Owner at a staff-blocked Institution, and 404 still comes first', async () => {
    const t = build(['a1', 'a2'], ['a1'], [staffOfA2]);
    expect(await t.service.requireInstitution(principal(), 'a2')).toMatchObject({
      institutionId: 'a2',
    });
    const admin = principal({ roleCode: 3 });
    expect(await status(() => t.service.requireInstitution(admin, 'elsewhere'))).toBe(404);
  });
});

describe('ScopeService.requireSociety', () => {
  const { service } = build();

  it('accepts the active Society', () => {
    expect(service.requireSociety(principal(), 'society-1')).toBe('society-1');
  });

  it('answers 404 for any other Society, and for a caller with none', () => {
    expect(() => service.requireSociety(principal(), 'society-2')).toThrow(AppException);
    expect(() => service.requireSociety(principal({ societyId: null }), 'society-1')).toThrow(
      AppException,
    );
  });
});
