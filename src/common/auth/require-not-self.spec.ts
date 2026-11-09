import { requireNotSelf } from './require-not-self.js';

describe('requireNotSelf', () => {
  it('refuses an administrator acting on their own account', () => {
    expect(() => requireNotSelf('a', 'b')).not.toThrow();
    expect(() => requireNotSelf('a', 'a')).toThrow(
      expect.objectContaining({ status: 409, code: 'CANNOT_ACT_ON_SELF' }),
    );
  });
});
