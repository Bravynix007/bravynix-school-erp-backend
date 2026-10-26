import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { message } from '../../common/i18n/messages.js';
import { RequestContext } from '../../common/request-context/request-context.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../audit/index.js';
import { DatabaseService } from '../database/index.js';
import { AuthCode, endReasonName, reportedStatus, userTypeFor } from './auth-codes.js';
import { canActAs, mobileContexts, type Context } from './contexts.js';
import { IdentityRepository } from './identity.repository.js';
import { SessionRepository } from './session.repository.js';
import type { SwitchContextDto } from './switch-context.dto.js';
import { TokenService } from './token.service.js';

export interface MeResult {
  userType: number | null;
  userTypeName: string | null;
  session: { id: string; activeContext: Context | null };
  person: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    preferredLanguage: string;
    accountStatus: number;
  };
  contexts: Context[];
  requiredNotices: never[];
}

export interface SwitchResult {
  accessToken: string;
  accessTokenExpiresAt: string;
  activeContext: Context;
  userType: number | null;
  userTypeName: string | null;
}

/** ME-01 and AUTH-06 (API design 6.3, 10.4): who the caller is and which role the session acts as. */
@Injectable()
export class ContextService {
  constructor(
    private readonly database: DatabaseService,
    private readonly identity: IdentityRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly tokens: TokenService,
  ) {}

  async me(principal: Principal): Promise<MeResult> {
    const { db } = this.database;
    const user = await this.identity.findUserById(db, principal.personId);
    // The verifier has just read this person's session; a missing row is a deleted account.
    if (!user) throw AppException.unauthorized();
    const grants = await this.sessions.activeGrants(db, user.id);
    const contexts =
      principal.clientType === 'mobile'
        ? mobileContexts(grants)
        : grants.some((grant) => grant.roleCode === 1)
          ? [{ roleCode: 1, societyId: null }]
          : [];
    return {
      ...userTypeFor(principal.roleCode),
      session: { id: principal.sessionId, activeContext: activeOf(principal) },
      person: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        preferredLanguage: user.preferredLanguage,
        accountStatus: reportedStatus(user.accountStatus),
      },
      contexts,
      requiredNotices: [],
    };
  }

  async switchContext(principal: Principal, request: SwitchContextDto): Promise<SwitchResult> {
    // The console has one context, Super Admin; only the mobile app chooses.
    if (principal.clientType !== 'mobile') throw AppException.forbidden();
    const societyId = this.checkPairing(request);

    const { db } = this.database;
    const grants = await this.sessions.activeGrants(db, principal.personId);
    if (!canActAs(mobileContexts(grants), request.roleCode, societyId)) {
      throw AppException.forbidden(AuthCode.CONTEXT_NOT_AVAILABLE);
    }

    const now = this.clock.now();
    await this.database.transaction({}, async (tx) => {
      const moved = await this.sessions.setActiveContext(
        tx,
        principal.sessionId,
        request.roleCode,
        societyId,
      );
      if (!moved) {
        // The session ended after the guard read it: answer as the guard would on the next call.
        const ended = await this.sessions.findSession(tx, principal.sessionId);
        throw AppException.unauthorized(ErrorCode.SESSION_ENDED, {
          reason: endReasonName(ended?.endReason ?? null),
        });
      }
      await this.audit.record(tx, {
        action: 'auth.context_switch',
        institutionId: null,
        societyId: null,
        entityType: 'user',
        entityId: principal.personId,
        actor: { userId: principal.personId, roleCode: principal.roleCode, displayName: null },
        before: { roleCode: principal.roleCode, societyId: principal.societyId },
        after: { roleCode: request.roleCode, societyId },
      });
    });
    const signed = await this.tokens.signAccessToken(
      {
        personId: principal.personId,
        sessionId: principal.sessionId,
        roleCode: request.roleCode,
        societyId,
        clientType: 'mobile',
      },
      now,
    );
    return {
      ...userTypeFor(request.roleCode),
      accessToken: signed.token,
      accessTokenExpiresAt: signed.expiresAt.toISOString(),
      activeContext: { roleCode: request.roleCode, societyId },
    };
  }

  /** Roles 2 to 4 name a Society; role 5 is the person, across Societies, and names none. */
  private checkPairing(request: SwitchContextDto): string | null {
    const language = RequestContext.current()?.language;
    if (request.roleCode === 5) {
      if (request.societyId != null) {
        throw AppException.validation([
          {
            field: 'societyId',
            code: FieldErrorCode.FIELD_NOT_ALLOWED,
            message: message(FieldErrorCode.FIELD_NOT_ALLOWED, language),
          },
        ]);
      }
      return null;
    }
    if (request.societyId == null) {
      throw AppException.validation([
        {
          field: 'societyId',
          code: FieldErrorCode.REQUIRED,
          message: message(FieldErrorCode.REQUIRED, language),
        },
      ]);
    }
    return request.societyId;
  }
}

function activeOf(principal: Principal): Context | null {
  return principal.roleCode === null
    ? null
    : { roleCode: principal.roleCode, societyId: principal.societyId };
}
