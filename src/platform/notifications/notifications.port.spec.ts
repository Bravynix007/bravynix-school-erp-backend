import type { Tx } from '../database/index.js';
import type { JobQueue } from '../jobs/index.js';
import { Notifications } from './notifications.port.js';

const id = (n: number) => `0198f0a0-0000-7000-8000-${n.toString().padStart(12, '0')}`;

const setup = () => {
  const enqueue = vi.fn<JobQueue['enqueue']>().mockResolvedValue(id(9));
  return { port: new Notifications({ enqueue } as unknown as JobQueue), enqueue };
};

const base = {
  societyId: id(1),
  institutionId: id(2),
  sourceKey: 'absent:s:e',
  occurredAt: new Date('2026-11-16T04:30:00.000Z'),
  category: 1,
  tab: 1 as const,
  title: 'Absent',
  body: 'Marked absent',
};

describe('Notifications', () => {
  it('queues a notify job in the caller’s transaction, with the Society and Institution on the job and not in the payload', async () => {
    const { port, enqueue } = setup();
    const tx = {} as Tx;
    const job = await port.notify(
      tx,
      { ...base, receivers: [{ userId: id(3), studentId: id(4) }] },
      id(5),
    );
    expect(job).toBe(id(9));
    expect(enqueue).toHaveBeenCalledWith(tx, {
      kind: 'notify',
      societyId: id(1),
      institutionId: id(2),
      startedBy: id(5),
      payload: expect.objectContaining({
        sourceKey: 'absent:s:e',
        receivers: [{ userId: id(3), studentId: id(4) }],
      }),
    });
  });

  it('queues nothing when there is nobody to tell', async () => {
    const { port, enqueue } = setup();
    await expect(port.notify({} as Tx, { ...base, receivers: [] }, null)).resolves.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a notice that is not well formed before it queues anything', async () => {
    const { port, enqueue } = setup();
    await expect(
      port.notify({} as Tx, { ...base, title: '', receivers: [{ userId: id(3) }] }, null),
    ).rejects.toThrow(/title/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
