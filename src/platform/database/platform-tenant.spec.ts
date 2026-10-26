import type { Principal } from '../../common/auth/access-token-verifier.js';
import { platformTenant } from './platform-tenant.js';

const principal = (roleCode: Principal['roleCode']): Principal => ({
  personId: 'admin-1',
  sessionId: 'session-1',
  roleCode,
  societyId: null,
  clientType: 'console',
  viaSupportAccess: false,
});

describe('platformTenant', () => {
  it('opens Super Admin’s context, naming the Society and Institutions it acts in', () => {
    expect(platformTenant(principal(1), 's1', ['i1'])).toEqual({
      personId: 'admin-1',
      roleCode: 1,
      societyId: 's1',
      institutionIds: ['i1'],
    });
  });

  it.each([2, 3, 4, 5, null] as const)('refuses a caller whose role is %s', (roleCode) => {
    expect(() => platformTenant(principal(roleCode), 's1')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});
