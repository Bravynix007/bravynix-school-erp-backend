import { MAX_ATTEMPTS, failureOf, retryDelaySeconds } from './jobs.rules.js';

describe('retryDelaySeconds', () => {
  it('waits longer after each attempt', () => {
    expect(retryDelaySeconds(1)).toBeLessThan(retryDelaySeconds(2));
    expect(retryDelaySeconds(MAX_ATTEMPTS - 1)).toBeLessThan(retryDelaySeconds(MAX_ATTEMPTS));
  });
});

describe('failureOf', () => {
  it('keeps an error code', () => {
    expect(failureOf({ code: 'CSV_UNREADABLE' })).toBe('CSV_UNREADABLE');
  });

  it('keeps only the name of an error that has no code, never its text', () => {
    expect(failureOf(new TypeError('person@example.test is not valid'))).toBe('TypeError');
  });

  it('does not take a code that is not a code, such as a database error number or free text', () => {
    expect(failureOf(Object.assign(new Error('x'), { code: '23505' }))).toBe('Error');
    expect(failureOf({ code: 'has a space and text' })).toBe('UNEXPECTED_ERROR');
  });

  it('answers for what is not an error at all', () => {
    expect(failureOf('boom')).toBe('UNEXPECTED_ERROR');
    expect(failureOf(null)).toBe('UNEXPECTED_ERROR');
  });
});
