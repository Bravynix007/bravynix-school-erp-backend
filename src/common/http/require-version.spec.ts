import { requireVersion } from './require-version.js';

describe('requireVersion', () => {
  it('answers a stale version with the current one', () => {
    expect(() => requireVersion({ version: 3 }, 3)).not.toThrow();
    expect(() => requireVersion({ version: 3 }, 2)).toThrow(
      expect.objectContaining({
        status: 409,
        code: 'VERSION_CONFLICT',
        options: { details: { currentVersion: 3 } },
      }),
    );
  });
});
