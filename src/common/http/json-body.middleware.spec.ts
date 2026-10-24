import { MAX_JSON_DEPTH, nestsDeeperThan } from './json-body.middleware.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('nestsDeeperThan', () => {
  it('allows nesting up to the limit', () => {
    const body = `{"a":${'['.repeat(MAX_JSON_DEPTH - 1)}${']'.repeat(MAX_JSON_DEPTH - 1)}}`;
    expect(nestsDeeperThan(bytes(body), MAX_JSON_DEPTH)).toBe(false);
  });

  it('refuses one level more', () => {
    const body = `{"a":${'['.repeat(MAX_JSON_DEPTH)}${']'.repeat(MAX_JSON_DEPTH)}}`;
    expect(nestsDeeperThan(bytes(body), MAX_JSON_DEPTH)).toBe(true);
  });

  it('ignores brackets and escaped quotes inside strings', () => {
    const body = `{"a":"${'['.repeat(100)} \\" ${'{'.repeat(100)}","b":"ಕನ್ನಡ"}`;
    expect(nestsDeeperThan(bytes(body), 2)).toBe(false);
  });
});
