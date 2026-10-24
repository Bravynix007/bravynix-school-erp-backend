import type { ExecutionContext } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import { AppVersionGuard, isOlderThan, isReadableVersion } from './app-version.guard.js';

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

describe('isReadableVersion', () => {
  it.each([
    ['1.4.2', true],
    ['1.4.2+57', true],
    ['1.2', false],
    ['abc', false],
    ['', false],
  ])('%s is readable: %s', (version, expected) => {
    expect(isReadableVersion(version)).toBe(expected);
  });
});

describe('AppVersionGuard', () => {
  const config = {
    env: { MIN_APP_VERSION_ANDROID: '1.4.0', PLAY_STORE_URL: 'https://play.example/app' },
  } as unknown as AppConfig;
  const guard = new AppVersionGuard(config);

  function call(headers: Record<string, string>) {
    const request = { header: (name: string) => headers[name.toLowerCase()] };
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return () => guard.canActivate(context);
  }

  it('lets a current build through', () => {
    expect(call({ 'x-app-platform': 'android', 'x-app-version': '1.4.0+12' })()).toBe(true);
  });

  it.each(['1.3.9', '1.2', 'abc'])('answers 426 to version %s', (version) => {
    expect(call({ 'x-app-platform': 'android', 'x-app-version': version })).toThrow(
      expect.objectContaining({ status: 426, code: 'APP_UPDATE_REQUIRED' }),
    );
  });

  it('ignores calls without the mobile headers (the console)', () => {
    expect(call({})()).toBe(true);
  });
});
