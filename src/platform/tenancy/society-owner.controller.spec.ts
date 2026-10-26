import type { Principal } from '../../common/auth/access-token-verifier.js';
import { SocietyOwnerController } from './society-owner.controller.js';
import type { SocietyOwnerService } from './society-owner.service.js';

const principal = { personId: 'admin-1' } as Principal;

function build() {
  const service = {
    add: vi.fn<SocietyOwnerService['add']>(),
    remove: vi.fn<SocietyOwnerService['remove']>(),
    list: vi.fn<SocietyOwnerService['list']>(),
  };
  return {
    controller: new SocietyOwnerController(service as unknown as SocietyOwnerService),
    service,
  };
}

describe('SocietyOwnerController', () => {
  it('adds an Owner to the Society in the path and answers 201', async () => {
    const { controller, service } = build();
    service.add.mockResolvedValue({ id: 'owner-1' } as never);
    const result = await controller.add(principal, 'society-1', { email: 'a@example.com' });
    expect(service.add).toHaveBeenCalledWith(principal, 'society-1', { email: 'a@example.com' });
    expect(result.options.status).toBe(201);
  });

  it('removes the person named in the path from the Society named in the path', async () => {
    const { controller, service } = build();
    await controller.remove(principal, 'society-1', 'owner-1');
    expect(service.remove).toHaveBeenCalledWith(principal, 'society-1', 'owner-1');
  });

  it('lists with the query as given', async () => {
    const { controller, service } = build();
    const query = { page: 1, limit: 20, q: 'asha' };
    await controller.list(principal, query);
    expect(service.list).toHaveBeenCalledWith(principal, query);
  });
});
