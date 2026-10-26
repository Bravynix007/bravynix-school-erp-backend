import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { GrantDirectory } from '../identity/index.js';
import { ScopeService } from './scope.service.js';
import type { ScopedInstitution, TenancyRepository } from './tenancy.repository.js';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  personId: 'person-1',
  sessionId: 'session-1',
  roleCode: 2,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
  ...overrides,
});

function build(institutions: ScopedInstitution[] = [], granted: string[] = []) {
  const activeInstitutions = vi
    .fn<TenancyRepository['activeInstitutions']>()
    .mockResolvedValue(institutions);
  const adminInstitutionIds = vi
    .fn<GrantDirectory['adminInstitutionIds']>()
    .mockResolvedValue(granted);
  const service = new ScopeService(
    { activeInstitutions } as unknown as TenancyRepository,
    { adminInstitutionIds } as unknown as GrantDirectory,
  );
  return { service, activeInstitutions, adminInstitutionIds };
}

const a1 = { id: 'a1', paused: false };
const a2 = { id: 'a2', paused: true };

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
    const t = build([a1, a2]);
    const scope = await t.service.forPrincipal(principal());
    expect(scope.institutions).toEqual([a1, a2]);
    expect(t.activeInstitutions).toHaveBeenCalledWith(
      { personId: 'person-1', roleCode: 2, societyId: 'society-1' },
      'society-1',
      null,
    );
    expect(t.adminInstitutionIds).not.toHaveBeenCalled();
  });

  it('gives an Institution Admin only the Institutions they hold a grant for', async () => {
    const t = build([a1], ['a1']);
    const scope = await t.service.forPrincipal(principal({ roleCode: 3 }));
    expect(scope.institutions).toEqual([a1]);
    expect(t.adminInstitutionIds).toHaveBeenCalledWith('person-1', 'society-1');
    expect(t.activeInstitutions).toHaveBeenCalledWith(expect.anything(), 'society-1', ['a1']);
  });

  it.each([
    ['a teacher', principal({ roleCode: 4 })],
    ['a parent', principal({ roleCode: 5, societyId: null })],
    ['Super Admin', principal({ roleCode: 1, societyId: null })],
    ['a session with no context', principal({ roleCode: null, societyId: null })],
    ['an owner with no Society', principal({ societyId: null })],
  ])('reaches no Institution for %s, and reads nothing', async (_who, caller) => {
    const t = build([a1]);
    expect((await t.service.forPrincipal(caller)).institutions).toEqual([]);
    expect(t.activeInstitutions).not.toHaveBeenCalled();
    expect(t.adminInstitutionIds).not.toHaveBeenCalled();
  });

  it('builds the Society-wide transaction scope from the Institutions in reach', async () => {
    const scope = await build([a1, a2]).service.forPrincipal(principal());
    expect(scope.tenant).toEqual({
      personId: 'person-1',
      roleCode: 2,
      societyId: 'society-1',
      institutionIds: ['a1', 'a2'],
    });
  });

  it('resolves once per request and again for the next one', async () => {
    const t = build([a1]);
    const caller = principal();
    await Promise.all([t.service.forPrincipal(caller), t.service.forPrincipal(caller)]);
    await t.service.forPrincipal(caller);
    expect(t.activeInstitutions).toHaveBeenCalledTimes(1);
    await t.service.forPrincipal(principal());
    expect(t.activeInstitutions).toHaveBeenCalledTimes(2);
  });
});

describe('ScopeService.requireInstitution', () => {
  it('opens a transaction scope narrowed to the one Institution', async () => {
    const context = await build([a1, a2]).service.requireInstitution(principal(), 'a1');
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
    const t = build([a1]);
    expect(await status(() => t.service.requireInstitution(principal(), 'elsewhere'))).toBe(404);
    expect(await status(() => t.service.requireInstitution(principal({ roleCode: 4 }), 'a1'))).toBe(
      404,
    );
  });

  it('answers 423 for a paused Institution', async () => {
    expect(await status(() => build([a1, a2]).service.requireInstitution(principal(), 'a2'))).toBe(
      423,
    );
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
