import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfig } from '../../config/app-config.js';
import { AppException } from './app-exception.js';
import { ErrorCode } from './error-codes.js';

/** 426 Upgrade Required; not in Nest's HttpStatus enum. */
const UPGRADE_REQUIRED = 426 as HttpStatus;

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** A store build always sends `major.minor.patch`, optionally with `+build`. */
export function isReadableVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

export function isOlderThan(version: string, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/**
 * Mobile calls carry `X-App-Version` and `X-App-Platform`. Below the minimum
 * supported version the API answers 426 APP_UPDATE_REQUIRED with the store
 * link (API design 5.2).
 */
@Injectable()
export class AppVersionGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    const platform = request.header('x-app-platform')?.toLowerCase();
    const version = request.header('x-app-version');
    if (!platform || !version) return true;

    const { env } = this.config;
    const [minimum, storeUrl] =
      platform === 'android'
        ? [env.MIN_APP_VERSION_ANDROID, env.PLAY_STORE_URL]
        : platform === 'ios'
          ? [env.MIN_APP_VERSION_IOS, env.APP_STORE_URL]
          : [undefined, undefined];
    // A version the API cannot read is treated as too old: it is not a store build.
    if (minimum && (!isReadableVersion(version) || isOlderThan(version, minimum))) {
      throw new AppException(UPGRADE_REQUIRED, ErrorCode.APP_UPDATE_REQUIRED, {
        details: { storeUrl: storeUrl ?? null, minimumVersion: minimum },
      });
    }
    return true;
  }
}
