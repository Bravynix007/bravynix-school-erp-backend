import { HttpStatus, Injectable } from '@nestjs/common';
import { AccessTokenVerifier, type Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import type { RoleCode } from '../../common/auth/roles.js';
import { Clock } from '../../common/time/clock.js';
import { DatabaseService } from '../database/index.js';
import { ClientType, SessionEndReason, endReasonName } from './auth-codes.js';
import { endIfNoLongerAllowed, MOBILE_SESSION_MS, TOUCH_AFTER_MS } from './session-rules.js';
import { SessionRepository } from './session.repository.js';
import { TokenService } from './token.service.js';

const ended = (endReason: number): AppException =>
  new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.SESSION_ENDED, {
    details: { reason: endReasonName(endReason) },
  });

/**
 * The per-request check (API design 6.1, 6.4): the token is signed and not
 * expired, and the session, the person's status and the grant behind the
 * active role are re-read from the database every time. Whatever the token
 * says about the role is a hint; the session row is the truth, so an ended
 * session, a block or a revoked grant cuts access at the next call.
 */
@Injectable()
export class SessionTokenVerifier extends AccessTokenVerifier {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionRepository,
    private readonly tokens: TokenService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async verify(token: string): Promise<Principal> {
    const now = this.clock.now();
    const check = await this.tokens.checkAccessToken(token, now);
    if (check.status === 'expired') throw AppException.unauthorized(ErrorCode.TOKEN_EXPIRED);
    if (check.status === 'invalid') throw AppException.unauthorized(ErrorCode.TOKEN_INVALID);

    const { db } = this.database;
    const session = await this.sessions.findSession(db, check.claims.sessionId);
    if (!session || session.userId !== check.claims.personId) {
      throw AppException.unauthorized(ErrorCode.TOKEN_INVALID);
    }
    if (session.endedAt) throw ended(session.endReason ?? SessionEndReason.Expired);

    if (
      session.idleExpiresAt <= now ||
      (session.absoluteExpiresAt !== null && session.absoluteExpiresAt <= now)
    ) {
      await this.sessions.endSession(db, session.id, SessionEndReason.Expired, now);
      throw ended(SessionEndReason.Expired);
    }
    const lost = await endIfNoLongerAllowed(this.sessions, db, session, now);
    if (lost !== null) throw ended(lost);

    // A mobile session lasts 30 days from last use.
    if (
      session.clientType === ClientType.Mobile &&
      now.getTime() - session.lastUsedAt.getTime() >= TOUCH_AFTER_MS
    ) {
      await this.sessions.touchSession(
        db,
        session.id,
        now,
        new Date(now.getTime() + MOBILE_SESSION_MS),
      );
    }

    return {
      personId: session.userId,
      sessionId: session.id,
      roleCode: session.activeRoleCode as RoleCode | null,
      societyId: session.activeSocietyId,
      clientType: session.clientType === ClientType.Mobile ? 'mobile' : 'console',
      viaSupportAccess: false,
    };
  }
}
