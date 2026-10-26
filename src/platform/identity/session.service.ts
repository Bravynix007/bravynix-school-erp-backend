import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { newId } from '../../common/ids/ids.js';
import { Clock } from '../../common/time/clock.js';
import { AuditOutcome, AuditService } from '../audit/index.js';
import { DatabaseService, type Tx } from '../database/index.js';
import { AuthCode, ClientType, SessionEndReason, endReasonName } from './auth-codes.js';
import type { RefreshCookie } from './console-cookie.js';
import { endIfNoLongerAllowed, MOBILE_SESSION_MS } from './session-rules.js';
import { PublicCallLimiter } from './public-call-limiter.js';
import { requestIp } from './request-ip.js';
import { SessionRepository, type SessionRow } from './session.repository.js';
import { secondsUntil } from './time-rules.js';
import { TokenService } from './token.service.js';

/** Where a refresh token came from: the body (mobile app) or the cookie (console). */
export type RefreshChannel = 'mobile' | 'console';

export interface RefreshResult {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** What the console gets instead of `refreshToken` in its body. */
  refreshCookie: RefreshCookie;
}

type Refused = { kind: 'refused'; error: AppException };
type Outcome = Refused | { kind: 'renewed'; session: SessionRow; expiresAt: Date };

const refused = (status: HttpStatus, code: string, details?: Record<string, unknown>): Refused => ({
  kind: 'refused',
  error: new AppException(status, code, { details }),
});

const sessionEnded = (endReason: number): Refused =>
  refused(HttpStatus.UNAUTHORIZED, ErrorCode.SESSION_ENDED, { reason: endReasonName(endReason) });

/**
 * AUTH-05, AUTH-07 and AUTH-08 (API design 10.3, 6.3): renew a session, end
 * this one, end all of a person's. A refresh token works once; presenting a
 * used one means it was copied, so the whole session ends (SDD 13.2).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly tokens: TokenService,
    private readonly limiter: PublicCallLimiter,
  ) {}

  async refresh(presented: string, channel: RefreshChannel): Promise<RefreshResult> {
    // Every call counts toward the per-IP limit, before a connection is held.
    await this.limiter.check(requestIp(), 'refresh');

    const next = this.tokens.newRefreshToken();
    const now = this.clock.now();
    const outcome = await this.database.transaction({}, (tx) =>
      this.rotate(tx, this.tokens.refreshTokenHmac(presented), next.hmac, channel, now),
    );
    // A reuse, an expiry or a blocked account is saved above, so the refusal is raised after the commit.
    if (outcome.kind === 'refused') throw outcome.error;

    const { session, expiresAt } = outcome;
    const signed = await this.tokens.signAccessToken(
      {
        personId: session.userId,
        sessionId: session.id,
        roleCode: session.activeRoleCode,
        societyId: session.activeSocietyId,
        clientType: channel,
      },
      now,
    );
    return {
      accessToken: signed.token,
      accessTokenExpiresAt: signed.expiresAt.toISOString(),
      refreshToken: next.token,
      refreshCookie: { value: next.token, maxAgeSeconds: secondsUntil(expiresAt, now) },
    };
  }

  private async rotate(
    tx: Tx,
    presentedHmac: Buffer,
    nextHmac: Buffer,
    channel: RefreshChannel,
    now: Date,
  ): Promise<Outcome> {
    // Locks the token row: a parallel refresh with the same token waits here and then sees `used_at`.
    const found = await this.sessions.lockRefreshToken(tx, presentedHmac);
    if (!found) return refused(HttpStatus.UNAUTHORIZED, AuthCode.REFRESH_TOKEN_INVALID);
    const { session } = found;

    if (session.endedAt) return sessionEnded(session.endReason ?? SessionEndReason.Expired);

    if (found.usedAt) {
      await this.sessions.endSession(tx, session.id, SessionEndReason.RefreshTokenReused, now);
      await this.audit.record(tx, {
        action: 'auth.token_reuse',
        institutionId: null,
        societyId: null,
        outcome: AuditOutcome.Denied,
        entityType: 'user',
        entityId: session.userId,
        actor: { userId: session.userId, roleCode: session.activeRoleCode, displayName: null },
        after: { channel: session.clientType === ClientType.Mobile ? 'mobile' : 'console' },
      });
      return refused(HttpStatus.UNAUTHORIZED, AuthCode.REFRESH_TOKEN_REUSED);
    }

    // A console token works only from the cookie and a mobile token only from the body.
    const mobile = session.clientType === ClientType.Mobile;
    if (mobile !== (channel === 'mobile')) {
      return refused(HttpStatus.UNAUTHORIZED, AuthCode.REFRESH_TOKEN_INVALID);
    }
    if (
      found.expiresAt <= now ||
      session.idleExpiresAt <= now ||
      (session.absoluteExpiresAt !== null && session.absoluteExpiresAt <= now)
    ) {
      await this.sessions.endSession(tx, session.id, SessionEndReason.Expired, now);
      return refused(HttpStatus.UNAUTHORIZED, AuthCode.REFRESH_TOKEN_INVALID);
    }

    const lost = await endIfNoLongerAllowed(this.sessions, tx, session, now);
    if (lost !== null) return sessionEnded(lost);

    // A mobile session moves 30 days on from now; a console session keeps its 12 hours from sign-in.
    const expiresAt = mobile
      ? new Date(now.getTime() + MOBILE_SESSION_MS)
      : (session.absoluteExpiresAt ?? session.idleExpiresAt);
    await this.sessions.markTokenUsed(tx, found.tokenId, now);
    await this.sessions.insertRefreshToken(tx, {
      id: newId(),
      sessionId: session.id,
      hmac: nextHmac,
      expiresAt,
      now,
    });
    if (mobile) await this.sessions.touchSession(tx, session.id, now, expiresAt);
    return { kind: 'renewed', session, expiresAt };
  }

  /** AUTH-07: ends this device's session. */
  async logout(principal: Principal): Promise<void> {
    await this.end(principal, SessionEndReason.Logout, 'auth.logout');
  }

  /** AUTH-08: ends every session of the person, this one included. */
  async logoutAll(principal: Principal): Promise<void> {
    await this.end(principal, SessionEndReason.LogoutAll, 'auth.logout_all');
  }

  private async end(principal: Principal, reason: SessionEndReason, action: string): Promise<void> {
    const now = this.clock.now();
    await this.database.transaction({}, async (tx) => {
      const ended =
        reason === SessionEndReason.LogoutAll
          ? await this.sessions.endUserSessions(tx, principal.personId, reason, now)
          : Number(await this.sessions.endSession(tx, principal.sessionId, reason, now));
      await this.audit.record(tx, {
        action,
        institutionId: null,
        societyId: null,
        entityType: 'user',
        entityId: principal.personId,
        actor: { userId: principal.personId, roleCode: principal.roleCode, displayName: null },
        after: { sessionsEnded: ended },
      });
    });
  }
}
