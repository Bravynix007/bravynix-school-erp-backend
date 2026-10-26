import type { Principal } from '../../common/auth/access-token-verifier.js';
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

function build(state: boolean | null) {
  const societyPauseState = vi
    .fn<TenancyRepository['societyPauseState']>()
    .mockResolvedValue(state);
  const gate = new TenancyAccessGate({ societyPauseState } as unknown as TenancyRepository);
  return { gate, societyPauseState };
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
});
