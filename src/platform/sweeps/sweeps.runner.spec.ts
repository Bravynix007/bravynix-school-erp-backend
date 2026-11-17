import { SweepsRunner } from './sweeps.runner.js';
import type { SweepsService } from './sweeps.service.js';
import { SWEEP_INTERVAL_MS } from './sweeps.rules.js';

describe('SweepsRunner.runUntil', () => {
  afterEach(() => vi.useRealTimers());

  it('sweeps at once and then every hour until told to stop', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn<SweepsService['sweep']>().mockResolvedValue({
      filesExpired: 0,
      filesRemoved: 0,
      importRunsRemoved: 0,
      answersRemoved: 0,
      inboxPartitionsMade: 0,
      inboxPartitionsDropped: 0,
    });
    const stop = new AbortController();
    const done = new SweepsRunner({ sweep } as unknown as SweepsService).runUntil(stop.signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);

    stop.abort();
    await done;
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a sweep that threw', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn<SweepsService['sweep']>().mockRejectedValue(new Error('boom'));
    const stop = new AbortController();
    const done = new SweepsRunner({ sweep } as unknown as SweepsService).runUntil(stop.signal);

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop.abort();
    await done;
  });
});
