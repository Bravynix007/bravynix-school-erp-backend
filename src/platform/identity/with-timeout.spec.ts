import { withTimeout } from './with-timeout.js';

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the result of work that finishes in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 3000, 'late')).resolves.toBe(7);
  });

  it('passes on the failure of work that fails in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('smtp down')), 3000, 'late')).rejects.toThrow(
      'smtp down',
    );
  });

  it('gives up on work that takes too long', async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => undefined);
    const result = withTimeout(never, 3000, 'EmailTimeout');
    const outcome = result.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(await outcome).toBe('EmailTimeout');
  });

  it('leaves no timer behind', async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve(1), 3000, 'late');
    expect(vi.getTimerCount()).toBe(0);
  });
});
