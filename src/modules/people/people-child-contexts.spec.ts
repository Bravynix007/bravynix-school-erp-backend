import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { InstitutionContext } from '../../platform/tenancy/index.js';
import type { ChildAccess } from './child-access.js';
import { PeopleChildContexts } from './people-child-contexts.js';

describe('PeopleChildContexts', () => {
  it('gives a parent the context of one child, as the child access checked it', async () => {
    const context: InstitutionContext = {
      institutionId: 'inst-1',
      societyId: 'society-1',
      tenant: { personId: 'parent-1', roleCode: 5, childIds: ['child-1'] },
    };
    const of = vi.fn<ChildAccess['of']>().mockResolvedValue(context);
    const parent = { personId: 'parent-1', roleCode: 5 } as Principal;
    expect(
      await new PeopleChildContexts({ of } as unknown as ChildAccess).of(parent, 'child-1'),
    ).toBe(context);
    expect(of).toHaveBeenCalledWith(parent, 'child-1');
  });
});
