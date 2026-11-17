import type { DatabaseService, Tx } from '../database/index.js';
import type { ClaimedJob, JobLease, JobRegistry } from '../jobs/index.js';
import type { NotificationsRepository } from './notifications.repository.js';
import { FANOUT_BATCH, payloadOfNotice } from './notifications.rules.js';
import { NotifyProcessor } from './notify.processor.js';
import { LogPushSender, type PushSender } from './push-sender.js';

const id = (n: number) => `0198f0a0-0000-7000-8000-${n.toString().padStart(12, '0')}`;

const job = (receivers: number): ClaimedJob => ({
  id: id(1),
  kind: 'notify',
  societyId: id(2),
  institutionId: null,
  startedBy: null,
  attempts: 1,
  payload: payloadOfNotice({
    societyId: id(2),
    institutionId: null,
    sourceKey: 'k',
    occurredAt: new Date('2026-11-16T04:30:00.000Z'),
    category: 1,
    tab: 1,
    title: 'Title',
    body: 'Body',
    receivers: Array.from({ length: receivers }, (_x, i) => ({ userId: id(100 + i) })),
  }),
});

const build = () => {
  const repository = {
    deliver: vi
      .fn<NotificationsRepository['deliver']>()
      .mockImplementation((_tx, notice) => Promise.resolve(notice.receivers.map((r) => r.userId))),
    devicesOf: vi
      .fn<NotificationsRepository['devicesOf']>()
      .mockImplementation((_tx, users) =>
        Promise.resolve(
          users.map((user) => ({ fcm_token: `t-${user}`, platform: 1, app_language: 'en' })),
        ),
      ),
    removeDevices: vi.fn<NotificationsRepository['removeDevices']>().mockResolvedValue(),
  };
  const sender = {
    send: vi
      .fn<PushSender['send']>()
      .mockImplementation((messages) => Promise.resolve(messages.map(() => 'sent' as const))),
  };
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work({} as Tx));
  const registry = { register: vi.fn<JobRegistry['register']>() };
  const lease = { keep: vi.fn<JobLease['keep']>().mockResolvedValue() };
  const processor = new NotifyProcessor(
    { transaction } as unknown as DatabaseService,
    repository as unknown as NotificationsRepository,
    sender as unknown as PushSender,
    registry as unknown as JobRegistry,
  );
  return { processor, repository, sender, transaction, registry, lease };
};

describe('NotifyProcessor', () => {
  it('registers itself for the notify kind', () => {
    const { processor, registry } = build();
    processor.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(processor);
    expect(processor.kind).toBe('notify');
  });

  it('writes under the Society of the job, 200 receivers at a time, renewing the lease before each batch', async () => {
    const { processor, repository, lease, transaction } = build();
    await processor.run(job(FANOUT_BATCH * 2 + 1), lease);
    expect(repository.deliver.mock.calls.map(([, notice]) => notice.receivers.length)).toEqual([
      FANOUT_BATCH,
      FANOUT_BATCH,
      1,
    ]);
    expect(lease.keep).toHaveBeenCalledTimes(3);
    expect(transaction).toHaveBeenCalledWith(
      { societyId: id(2), institutionIds: [] },
      expect.any(Function),
    );
    expect(repository.deliver.mock.calls[0]?.[1]).toMatchObject({
      societyId: id(2),
      institutionId: null,
      sourceKey: 'k',
    });
  });

  it('narrows to the Institution of the job when it has one', async () => {
    const { processor, lease, transaction } = build();
    await processor.run({ ...job(1), institutionId: id(3) }, lease);
    expect(transaction).toHaveBeenCalledWith(
      { societyId: id(2), institutionIds: [id(3)] },
      expect.any(Function),
    );
  });

  it('sends the push only to the phones of the people whose row was added', async () => {
    const { processor, repository, sender, lease } = build();
    repository.deliver.mockResolvedValue([id(100)]);
    await processor.run(job(2), lease);
    expect(repository.devicesOf).toHaveBeenCalledWith(expect.anything(), [id(100)]);
    expect(sender.send).toHaveBeenCalledWith([
      { token: `t-${id(100)}`, platform: 1, language: 'en', title: 'Title', body: 'Body' },
    ]);
  });

  it('sends nothing, and asks for no phones, when every row was there already', async () => {
    const { processor, repository, sender, lease } = build();
    repository.deliver.mockResolvedValue([]);
    await processor.run(job(2), lease);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('removes the tokens the provider calls invalid, and only those', async () => {
    const { processor, repository, sender, lease } = build();
    sender.send.mockResolvedValue(['invalid_token', 'sent', 'failed']);
    await processor.run(job(3), lease);
    expect(repository.removeDevices).toHaveBeenCalledWith(expect.anything(), [`t-${id(100)}`]);
  });

  it('goes on to the next batch, and settles the job, when a push cannot be sent', async () => {
    const { processor, repository, sender, lease } = build();
    sender.send.mockRejectedValue(new Error('provider is down'));
    await expect(processor.run(job(FANOUT_BATCH + 1), lease)).resolves.toBeUndefined();
    expect(repository.deliver).toHaveBeenCalledTimes(2);
  });

  it('stops where it is when the lease is lost', async () => {
    const { processor, repository, lease } = build();
    lease.keep.mockRejectedValue(new Error('lost'));
    await expect(processor.run(job(1), lease)).rejects.toThrow('lost');
    expect(repository.deliver).not.toHaveBeenCalled();
  });

  it('fails a job whose payload is not a notice', async () => {
    const { processor, lease } = build();
    await expect(processor.run({ ...job(1), payload: {} }, lease)).rejects.toThrow(
      'A notify job needs a notice',
    );
  });

  it('has no record to settle when a job fails for good', async () => {
    const { processor } = build();
    await expect(processor.fail(job(1), 'ATTEMPTS_EXHAUSTED')).resolves.toBeUndefined();
  });
});

describe('LogPushSender', () => {
  it('answers sent for every message and sends nothing', async () => {
    const outcomes = await new LogPushSender().send([
      { token: 'a', platform: 1, language: 'en', title: 't', body: 'b' },
      { token: 'b', platform: 2, language: 'en', title: 't', body: 'b' },
    ]);
    expect(outcomes).toEqual(['sent', 'sent']);
  });
});
