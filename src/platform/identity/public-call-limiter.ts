import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { Clock } from '../../common/time/clock.js';
import { DatabaseService } from '../database/index.js';
import { IdentityRepository } from './identity.repository.js';
import { evaluateIpLimit, OTP_LIMITS } from './otp-limits.js';

/**
 * The per-IP limit on public login calls (API design 6.2, 18.1): 20 a minute,
 * counted for every call, refused or not, because a refused call still takes a
 * connection and runs queries. Kept in the database so the limit holds across
 * API tasks, as one row per IP per minute bumped by a single statement, so
 * a flood costs one round trip each and holds no lock. Every public auth endpoint calls `check` first, before any other
 * work.
 */
@Injectable()
export class PublicCallLimiter {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: IdentityRepository,
    private readonly clock: Clock,
  ) {}

  /** Throws 429 `RATE_LIMITED` when this IP is over the limit. A call with no known IP is not counted. */
  async check(ip: string | null): Promise<void> {
    if (ip === null) return;
    const now = this.clock.now();
    const windowMs = OTP_LIMITS.ipWindowSeconds * 1000;
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const calls = await this.repository.countPublicCall(this.database.db, ip, windowStart);
    const refusal = evaluateIpLimit(now, windowStart, calls);
    if (refusal) {
      throw new AppException(refusal.status, refusal.code, {
        retryAfterSeconds: refusal.retryAfterSeconds,
      });
    }
  }
}
