import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { RequestScope, ScopeService } from './scope.service.js';
import { TenancyAccessGate } from './tenancy-access-gate.js';
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

function build(state: boolean | null, paused: boolean[] = []) {
  const societyPauseState = vi
    .fn<TenancyRepository['societyPauseState']>()
    .mockResolvedValue(state);
  const forPrincipal = vi.fn<ScopeService['forPrincipal']>().mockResolvedValue({
    institutions: paused.map((isPaused, i) => ({ id: `i${i}`, paused: isPaused })),
  } as unknown as RequestScope);
  const gate = new TenancyAccessGate(
    { societyPauseState } as unknown as TenancyRepository,
    { forPrincipal } as unknown as ScopeService,
  );
  return { gate, societyPauseState, forPrincipal };
}

describe('TenancyAccessGate', () => {
  it('reports a paused Society', async () => {
    expect(await build(true).gate.isPaused(principal())).toBe(true);
  });

  it('reports an open Society', async () => {
    expect(await build(false).gate.isPaused(principal())).toBe(false);
  });

  it('counts a Society the caller cannot see as paused, so an unknown scope never opens the door', async () => {
    expect(await build(null).gate.isPaused(principal())).toBe(true);
  });

  it('does not look anything up for a caller with no Society', async () => {
    const { gate, societyPauseState } = build(true);
    expect(await gate.isPaused(principal({ societyId: null, roleCode: 1 }))).toBe(false);
    expect(societyPauseState).not.toHaveBeenCalled();
  });

  it('reads the Society as the caller, so row-level security applies to the check itself', async () => {
    const { gate, societyPauseState } = build(false);
    await gate.isPaused(principal());
    expect(societyPauseState).toHaveBeenCalledWith(
      { personId: 'person-1', societyId: 'society-1', roleCode: 2, viaSupportAccess: false },
      'society-1',
    );
  });

  describe('an Institution Admin', () => {
    const admin = principal({ roleCode: 3 });

    it('is stopped when every Institution they reach is paused', async () => {
      expect(await build(false, [true]).gate.isPaused(admin)).toBe(true);
      expect(await build(false, [true, true]).gate.isPaused(admin)).toBe(true);
    });

    it('carries on while one Institution is open', async () => {
      expect(await build(false, [true, false]).gate.isPaused(admin)).toBe(false);
    });

    it('is not stopped for reaching no Institution: there is nothing paused to blame', async () => {
      expect(await build(false, []).gate.isPaused(admin)).toBe(false);
    });

    it('is stopped by a Society pause without reading the Institutions', async () => {
      const t = build(true, [false]);
      expect(await t.gate.isPaused(admin)).toBe(true);
      expect(t.forPrincipal).not.toHaveBeenCalled();
    });
  });

  it('leaves a Society Owner running while every Institution is paused', async () => {
    const t = build(false, [true, true]);
    expect(await t.gate.isPaused(principal({ roleCode: 2 }))).toBe(false);
    expect(t.forPrincipal).not.toHaveBeenCalled();
  });
});
