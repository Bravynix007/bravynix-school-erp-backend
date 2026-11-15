import { JobLeaseLost, JobRegistry, type ClaimedJob, type JobHandler } from './job-handler.js';
import { JobRunner } from './job-runner.js';
import type { JobsRepository } from './jobs.repository.js';
import { MAX_ATTEMPTS, retryDelaySeconds } from './jobs.rules.js';

const job = (changes: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: 'job-1',
  kind: 'test.work',
  societyId: 'society-1',
  institutionId: 'institution-1',
  startedBy: 'person-1',
  payload: {},
  attempts: 1,
  ...changes,
});

function build(claimed: ClaimedJob | undefined, handler?: Partial<JobHandler>, extended = true) {
  const repository = {
    claim: vi.fn<JobsRepository['claim']>().mockResolvedValue(claimed),
    extend: vi.fn<JobsRepository['extend']>().mockResolvedValue(extended),
    settle: vi.fn<JobsRepository['settle']>().mockResolvedValue(undefined),
    retry: vi.fn<JobsRepository['retry']>().mockResolvedValue(undefined),
  };
  const registry = new JobRegistry();
  const full: JobHandler = {
    kind: 'test.work',
    run: vi.fn<JobHandler['run']>().mockResolvedValue(undefined),
    fail: vi.fn<JobHandler['fail']>().mockResolvedValue(undefined),
    ...handler,
  };
  if (handler !== undefined || claimed?.kind === 'test.work') registry.register(full);
  return {
    runner: new JobRunner(repository as unknown as JobsRepository, registry),
    repository,
    handler: full,
  };
}

describe('JobRunner.runNext', () => {
  it('does nothing and says so when no job is due', async () => {
    const { runner, repository } = build(undefined);
    expect(await runner.runNext()).toBe(false);
    expect(repository.settle).not.toHaveBeenCalled();
  });

  it('runs the handler of the job and settles it as done', async () => {
    const { runner, repository, handler } = build(job());
    expect(await runner.runNext()).toBe(true);
    expect(handler.run).toHaveBeenCalledWith(
      job(),
      expect.objectContaining({ keep: expect.any(Function) }),
    );
    expect(repository.settle).toHaveBeenCalledWith('job-1', true, null);
  });

  it('fails a job nobody handles, with a code', async () => {
    const { runner, repository } = build(job({ kind: 'other.work' }));
    await runner.runNext();
    expect(repository.settle).toHaveBeenCalledWith('job-1', false, 'NO_HANDLER');
  });

  it('queues the job again after a pause when the handler stops on a fault, keeping a code and not the text', async () => {
    const run = vi.fn<JobHandler['run']>().mockRejectedValue(new TypeError('person@example.test'));
    const { runner, repository } = build(job({ attempts: 2 }), { run });
    await runner.runNext();
    expect(repository.retry).toHaveBeenCalledWith('job-1', retryDelaySeconds(2), 'TypeError');
    expect(repository.settle).not.toHaveBeenCalled();
  });

  it('gives up after the last attempt: the handler settles its record, then the job fails', async () => {
    const run = vi.fn<JobHandler['run']>().mockRejectedValue(new Error('down'));
    const { runner, repository, handler } = build(job({ attempts: MAX_ATTEMPTS }), { run });
    await runner.runNext();
    expect(handler.fail).toHaveBeenCalledWith(job({ attempts: MAX_ATTEMPTS }), 'Error');
    expect(repository.settle).toHaveBeenCalledWith('job-1', false, 'Error');
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it('gives up on a job claimed more often than the limit without running it again', async () => {
    const { runner, repository, handler } = build(job({ attempts: MAX_ATTEMPTS + 1 }));
    await runner.runNext();
    expect(handler.run).not.toHaveBeenCalled();
    expect(handler.fail).toHaveBeenCalledWith(expect.anything(), 'ATTEMPTS_EXHAUSTED');
    expect(repository.settle).toHaveBeenCalledWith('job-1', false, 'ATTEMPTS_EXHAUSTED');
  });

  it('still fails the job when the handler cannot settle its record', async () => {
    const fail = vi.fn<JobHandler['fail']>().mockRejectedValue(new Error('down'));
    const { runner, repository } = build(job({ attempts: MAX_ATTEMPTS + 1 }), { fail });
    await expect(runner.runNext()).rejects.toThrow('down');
    expect(repository.settle).toHaveBeenCalledWith('job-1', false, 'ATTEMPTS_EXHAUSTED');
  });

  it('leaves a job alone when its lease was lost to another worker', async () => {
    const run = vi.fn<JobHandler['run']>().mockRejectedValue(new JobLeaseLost());
    const { runner, repository } = build(job(), { run });
    expect(await runner.runNext()).toBe(true);
    expect(repository.settle).not.toHaveBeenCalled();
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it('gives the handler a lease that renews, and that throws when another worker has the job', async () => {
    let lease: { keep(): Promise<void> } | undefined;
    const run = vi.fn<JobHandler['run']>((_job: ClaimedJob, held: { keep(): Promise<void> }) => {
      lease = held;
      return Promise.resolve();
    });
    const lost = build(job(), { run }, false);
    await lost.runner.runNext();
    await expect(lease!.keep()).rejects.toBeInstanceOf(JobLeaseLost);
    const kept = build(job(), { run }, true);
    await kept.runner.runNext();
    await expect(lease!.keep()).resolves.toBeUndefined();
    expect(kept.repository.extend).toHaveBeenCalledWith('job-1', expect.any(Number));
  });
});

describe('JobRunner.runUntil', () => {
  it('runs jobs until it is told to stop, then returns', async () => {
    const controller = new AbortController();
    const { runner, repository } = build(job());
    repository.settle.mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    await runner.runUntil(controller.signal);
    expect(repository.claim).toHaveBeenCalledTimes(1);
  });

  it('keeps going when the queue cannot be reached', async () => {
    const controller = new AbortController();
    const { runner, repository } = build(undefined);
    repository.claim.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('connection lost'));
    });
    await expect(runner.runUntil(controller.signal)).resolves.toBeUndefined();
  });
});

describe('JobRegistry', () => {
  it('refuses two handlers for one kind', () => {
    const registry = new JobRegistry();
    const handler = {
      kind: 'a',
      run: vi.fn<JobHandler['run']>(),
      fail: vi.fn<JobHandler['fail']>(),
    };
    registry.register(handler);
    expect(() => registry.register(handler)).toThrow(/already registered/);
    expect(registry.handlerFor('a')).toBe(handler);
    expect(registry.handlerFor('b')).toBeUndefined();
  });
});
