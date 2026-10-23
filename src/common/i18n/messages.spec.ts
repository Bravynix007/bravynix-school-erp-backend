import { message, resolveLanguage } from './messages.js';

describe('resolveLanguage', () => {
  it('defaults to English', () => {
    expect(resolveLanguage(undefined)).toBe('en');
    expect(resolveLanguage('fr-FR,de;q=0.8')).toBe('en');
  });

  it('picks the best supported language by quality', () => {
    expect(resolveLanguage('fr;q=0.9,hi-IN;q=0.8,ta;q=0.5')).toBe('hi');
    expect(resolveLanguage('kn')).toBe('kn');
    expect(resolveLanguage('en;q=0.4, te;q=0.9')).toBe('te');
  });
});

describe('message', () => {
  it('falls back to English, then to the code itself', () => {
    expect(message('NOT_FOUND', 'hi')).toBe('Not found');
    expect(message('SOME_NEW_CODE')).toBe('SOME_NEW_CODE');
  });
});
