import { isOlderThan } from './app-version.guard.js';

describe('isOlderThan', () => {
  it.each([
    ['1.4.2', '1.4.3', true],
    ['1.4.3', '1.4.3', false],
    ['1.10.0', '1.9.9', false],
    ['0.9.9', '1.0.0', true],
    ['2.0.0', '1.99.99', false],
    ['1.4.2+57', '1.4.2', false],
  ])('%s older than %s is %s', (version, minimum, expected) => {
    expect(isOlderThan(version, minimum)).toBe(expected);
  });

  it('never blocks on a version it cannot read', () => {
    expect(isOlderThan('dev', '1.0.0')).toBe(false);
  });
});
