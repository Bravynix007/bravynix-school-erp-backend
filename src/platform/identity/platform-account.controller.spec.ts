import type { Principal } from '../../common/auth/access-token-verifier.js';
import { PlatformAccountController } from './platform-account.controller.js';
import type { PlatformAccountService } from './platform-account.service.js';

const principal = { personId: 'admin-1' } as Principal;
const user = 'user-1';

/** Every route hands the caller, the path ID and the body to its service call, in that order. */
function build() {
  const answer = Promise.resolve('answer');
  const service = {
    listSuperAdmins: vi.fn<PlatformAccountService['listSuperAdmins']>(),
    addSuperAdmin: vi.fn<PlatformAccountService['addSuperAdmin']>(),
    removeSuperAdmin: vi.fn<PlatformAccountService['removeSuperAdmin']>(),
    block: vi.fn<PlatformAccountService['block']>(),
    unblock: vi.fn<PlatformAccountService['unblock']>(),
    changeEmail: vi.fn<PlatformAccountService['changeEmail']>(),
    resetAuthenticator: vi.fn<PlatformAccountService['resetAuthenticator']>(),
    unlock: vi.fn<PlatformAccountService['unlock']>(),
  };
  for (const call of Object.values(service)) call.mockReturnValue(answer as never);
  return {
    controller: new PlatformAccountController(service as unknown as PlatformAccountService),
    service,
  };
}

describe('PlatformAccountController', () => {
  it('lists and removes Super Admins for the caller', async () => {
    const { controller, service } = build();
    await controller.list(principal);
    await controller.remove(principal, user);
    expect(service.listSuperAdmins).toHaveBeenCalledWith(principal);
    expect(service.removeSuperAdmin).toHaveBeenCalledWith(principal, user);
  });

  it('answers an added Super Admin with 201', async () => {
    const { controller, service } = build();
    service.addSuperAdmin.mockResolvedValue({ id: 'new' } as never);
    const result = await controller.add(principal, { email: 'a@example.com' });
    expect(result.options.status).toBe(201);
    expect(result.data).toEqual({ id: 'new' });
    expect(service.addSuperAdmin).toHaveBeenCalledWith(principal, { email: 'a@example.com' });
  });

  it('passes the person and the body to block, unblock, email change and unlock', async () => {
    const { controller, service } = build();
    await controller.block(principal, user, { version: 2, reason: 'x' });
    await controller.unblock(principal, user, { version: 3 });
    await controller.changeEmail(principal, user, { version: 4, email: 'new@example.com' });
    await controller.unlock(principal, user, { reason: 'y' });
    await controller.resetAuthenticator(principal, user);
    expect(service.block).toHaveBeenCalledWith(principal, user, { version: 2, reason: 'x' });
    expect(service.unblock).toHaveBeenCalledWith(principal, user, { version: 3 });
    expect(service.changeEmail).toHaveBeenCalledWith(principal, user, {
      version: 4,
      email: 'new@example.com',
    });
    expect(service.unlock).toHaveBeenCalledWith(principal, user, { reason: 'y' });
    expect(service.resetAuthenticator).toHaveBeenCalledWith(principal, user);
  });
});
