import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { TenancyRepository } from './tenancy.repository.js';
import { TenancyService } from './tenancy.service.js';

const principal: Principal = {
  personId: 'person-1',
  sessionId: 'session-1',
  roleCode: 3,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
};

function build(state: boolean | null) {
  const institutionPauseState = vi
    .fn<TenancyRepository['institutionPauseState']>()
    .mockResolvedValue(state);
  const service = new TenancyService({ institutionPauseState } as unknown as TenancyRepository);
  return { service, institutionPauseState };
}

describe('TenancyService.isInstitutionPaused', () => {
  it.each([
    [true, true],
    [false, false],
    [null, true],
  ])(
    'maps the stored state %s to %s (an Institution nobody can see counts as paused)',
    async (state, expected) => {
      expect(await build(state).service.isInstitutionPaused(principal, 'institution-1')).toBe(
        expected,
      );
    },
  );

  it("asks as the caller, so another Society's Institution is not visible", async () => {
    const { service, institutionPauseState } = build(false);
    await service.isInstitutionPaused(principal, 'institution-1');
    expect(institutionPauseState).toHaveBeenCalledWith(
      { personId: 'person-1', societyId: 'society-1', roleCode: 3, viaSupportAccess: false },
      'institution-1',
    );
  });
});
