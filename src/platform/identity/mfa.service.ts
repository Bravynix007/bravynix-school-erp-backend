import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { newId } from '../../common/ids/ids.js';
import { RequestContext } from '../../common/request-context/request-context.js';
import { Clock } from '../../common/time/clock.js';
import { AuditOutcome, AuditService } from '../audit/index.js';
import type { EmailMessage } from '../email/email-sender.js';
import { DatabaseService, type Tx } from '../database/index.js';
import { AccountStatus, AuthCode, ClientType } from './auth-codes.js';
import { BackgroundMailer } from './background-mailer.js';
import type { RefreshCookie } from './console-cookie.js';
import { CONSOLE_CONTEXT } from './contexts.js';
import { authenticatorLockoutEmail } from './lockout-email.js';
import { IdentityRepository, type LoginUser } from './identity.repository.js';
import { buildLoginResult, displayName, type LoginResult } from './login-result.js';
import { MfaRepository, type TotpFactor } from './mfa.repository.js';
import { MFA_LOCK } from './otp-limits.js';
import { PublicCallLimiter } from './public-call-limiter.js';
import { requestIp } from './request-ip.js';
import { SecretBox } from './secret-box.js';
import { CONSOLE_SESSION_MS } from './session-rules.js';
import { SessionRepository } from './session.repository.js';
import { secondsUntil } from './time-rules.js';
import { TokenService } from './token.service.js';
import { base32Encode, generateTotpSecret, matchTotp, setupUri } from './totp.js';

/** The step between the email code and a console session (API design 6.2, 10.2a, 10.2b). */
export const MFA_LIMITS = {
  /** How long the token from AUTH-02 lasts. */
  tokenSeconds: 300,
  /** Wrong authenticator codes a token allows; the token is dead after the last. */
  triesPerToken: 5,
  issuer: 'BravyNix School ERP',
} as const;

export interface MfaStart {
  mfaToken: string;
  mfaEnrolled: boolean;
}

export interface MfaEnrolment {
  setupUri: string;
  secret: string;
}

/** A signed-in console session: the body for the client, and the cookie for the refresh token. */
export interface ConsoleLogin {
  result: LoginResult;
  refreshCookie: RefreshCookie;
}

type Refused = { kind: 'refused'; error: AppException; mail?: EmailMessage };
type Admitted = {
  kind: 'admitted';
  challengeId: string;
  user: LoginUser;
  factor: TotpFactor | undefined;
};

const refused = (
  status: HttpStatus,
  code: string,
  details?: Record<string, unknown>,
  retryAfterSeconds?: number,
): Refused => ({
  kind: 'refused',
  error: new AppException(status, code, { details, retryAfterSeconds }),
});

const tokenExpired = (): Refused => refused(HttpStatus.UNAUTHORIZED, AuthCode.MFA_TOKEN_EXPIRED);

/**
 * AUTH-03 and AUTH-04: the Super Admin's authenticator app. A correct email
 * code on the console spends that code and hands out a 5-minute token (stored
 * only as a keyed hash); this service trades the token plus an authenticator
 * code for a console session. The secret is kept encrypted, a code works once,
 * and a token allows five wrong codes.
 *
 * Accepted risk (API design 6.2): the first enrolment trusts the mailbox, as
 * the email code is the only thing proving who is signing in; the next
 * sign-ins need the app. Guessing a code is bounded by five tries per token
 * and by the limits on getting a token.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly database: DatabaseService,
    private readonly identity: IdentityRepository,
    private readonly sessions: SessionRepository,
    private readonly factors: MfaRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly tokens: TokenService,
    private readonly secrets: SecretBox,
    private readonly limiter: PublicCallLimiter,
    private readonly mailer: BackgroundMailer,
  ) {}

  /** When the console is closed to this person after too many wrong authenticator codes, or null. */
  async activeLock(tx: Tx, userId: string, now: Date): Promise<Date | null> {
    const factor = await this.factors.findFactor(tx, userId);
    return factor?.lockedUntil && factor.lockedUntil > now ? factor.lockedUntil : null;
  }

  /** Called inside the email-code transaction: opens the step and returns what AUTH-02 answers. */
  async begin(tx: Tx, userId: string, now: Date): Promise<MfaStart> {
    await this.factors.spendOpenChallenges(tx, userId, now);
    const token = this.tokens.newMfaToken();
    await this.factors.insertChallenge(tx, {
      id: newId(),
      userId,
      hmac: token.hmac,
      expiresAt: new Date(now.getTime() + MFA_LIMITS.tokenSeconds * 1000),
      now,
    });
    const factor = await this.factors.findFactor(tx, userId);
    return { mfaToken: token.token, mfaEnrolled: factor?.confirmedAt != null };
  }

  /** AUTH-03: a new secret for a Super Admin who has not confirmed an authenticator yet. */
  async enrol(mfaToken: string): Promise<MfaEnrolment> {
    await this.limiter.check(requestIp());
    const now = this.clock.now();
    const outcome = await this.database.transaction({}, async (tx) => {
      const admitted = await this.admit(tx, mfaToken, now);
      if (admitted.kind === 'refused') return admitted;
      const { user } = admitted;

      const secret = generateTotpSecret();
      const saved = await this.factors.savePendingFactor(
        tx,
        user.id,
        this.secrets.seal(secret, user.id),
        this.secrets.keyVersion,
      );
      if (!saved) return refused(HttpStatus.CONFLICT, AuthCode.MFA_ALREADY_ENROLLED);
      await this.audit.record(tx, {
        action: 'auth.mfa_enrol_started',
        institutionId: null,
        societyId: null,
        entityType: 'user',
        entityId: user.id,
        actor: { userId: user.id, roleCode: null, displayName: displayName(user) },
      });
      return {
        kind: 'enrolled' as const,
        enrolment: {
          setupUri: setupUri(secret, MFA_LIMITS.issuer, user.email),
          secret: base32Encode(secret),
        },
      };
    });
    if (outcome.kind === 'refused') throw outcome.error;
    return outcome.enrolment;
  }

  /** AUTH-04: checks the authenticator code and starts the console session. */
  async verify(mfaToken: string, code: string): Promise<ConsoleLogin> {
    const ip = requestIp();
    await this.limiter.check(ip);
    const now = this.clock.now();
    const refresh = this.tokens.newRefreshToken();
    const sessionId = newId();
    const expiresAt = new Date(now.getTime() + CONSOLE_SESSION_MS);

    const outcome = await this.database.transaction({}, async (tx) => {
      const admitted = await this.admit(tx, mfaToken, now);
      if (admitted.kind === 'refused') return admitted;
      const { challengeId, user, factor } = admitted;
      if (!factor) return refused(HttpStatus.CONFLICT, AuthCode.MFA_NOT_ENROLLED);

      const secret = this.secrets.open(factor.secretCiphertext, user.id);
      const step = matchTotp(secret, code, now, factor.lastUsedStep);
      // A second sign-in using the same code at the same moment loses here.
      if (step === null || !(await this.factors.useStep(tx, user.id, step, now))) {
        return this.recordWrongCode(tx, challengeId, user, now);
      }

      await this.factors.spendChallenge(tx, challengeId, now);
      await this.identity.recordLogin(tx, user.id, now);
      await this.sessions.createSession(tx, {
        id: sessionId,
        userId: user.id,
        clientType: ClientType.Console,
        activeRoleCode: CONSOLE_CONTEXT.roleCode,
        activeSocietyId: null,
        now,
        // Twelve hours from sign-in, and no extension: the two deadlines are one.
        idleExpiresAt: expiresAt,
        absoluteExpiresAt: expiresAt,
        ip,
        userAgent: RequestContext.current()?.userAgent?.slice(0, 300) ?? null,
        deviceLabel: null,
      });
      await this.sessions.insertRefreshToken(tx, {
        id: newId(),
        sessionId,
        hmac: refresh.hmac,
        expiresAt,
        now,
      });
      const actor = {
        userId: user.id,
        roleCode: CONSOLE_CONTEXT.roleCode,
        displayName: displayName(user),
      };
      if (factor.confirmedAt === null) {
        await this.audit.record(tx, {
          action: 'auth.mfa_enrolled',
          institutionId: null,
          societyId: null,
          entityType: 'user',
          entityId: user.id,
          actor,
        });
      }
      await this.audit.record(tx, {
        action: 'auth.login',
        institutionId: null,
        societyId: null,
        entityType: 'user',
        entityId: user.id,
        actor,
        after: { channel: 'console' },
      });
      return { kind: 'signedIn' as const, user };
    });
    // A wrong code and a spent token are saved above, so the refusal is raised after the commit.
    if (outcome.kind === 'refused') {
      if (outcome.mail) this.mailer.send(outcome.mail);
      throw outcome.error;
    }

    const accessToken = await this.tokens.signAccessToken(
      {
        personId: outcome.user.id,
        sessionId,
        roleCode: CONSOLE_CONTEXT.roleCode,
        societyId: null,
        clientType: 'console',
      },
      now,
    );
    return {
      result: buildLoginResult({
        user: outcome.user,
        sessionId,
        contexts: [CONSOLE_CONTEXT],
        active: CONSOLE_CONTEXT,
        accessToken,
        refreshToken: null,
      }),
      refreshCookie: { value: refresh.token, maxAgeSeconds: secondsUntil(expiresAt, now) },
    };
  }

  /**
   * Locks the token's row and checks it can still be used and that its person
   * may still sign in to the console. A person who cannot has the token spent,
   * so they start again rather than retry.
   */
  private async admit(tx: Tx, mfaToken: string, now: Date): Promise<Admitted | Refused> {
    const challenge = await this.factors.lockChallenge(tx, this.tokens.mfaTokenHmac(mfaToken));
    if (
      !challenge ||
      challenge.usedAt !== null ||
      challenge.expiresAt <= now ||
      challenge.failedTries >= MFA_LIMITS.triesPerToken
    ) {
      return tokenExpired();
    }
    const user = await this.identity.findUserById(tx, challenge.userId);
    if (!user || user.accountStatus === AccountStatus.Inactive) return tokenExpired();
    if (user.accountStatus === AccountStatus.Blocked) {
      await this.factors.spendChallenge(tx, challenge.id, now);
      return refused(HttpStatus.FORBIDDEN, AuthCode.ACCOUNT_BLOCKED);
    }
    if (!(await this.identity.hasActiveSuperAdminGrant(tx, user.id))) {
      await this.factors.spendChallenge(tx, challenge.id, now);
      return refused(HttpStatus.FORBIDDEN, AuthCode.CONSOLE_NOT_ALLOWED);
    }
    const factor = await this.factors.findFactor(tx, user.id);
    if (factor?.lockedUntil && factor.lockedUntil > now) {
      await this.factors.spendChallenge(tx, challenge.id, now);
      return refused(
        HttpStatus.LOCKED,
        AuthCode.AUTH_LOCKED,
        undefined,
        secondsUntil(factor.lockedUntil, now),
      );
    }
    return { kind: 'admitted', challengeId: challenge.id, user, factor };
  }

  private async recordWrongCode(
    tx: Tx,
    challengeId: string,
    user: LoginUser,
    now: Date,
  ): Promise<Refused> {
    const tries = await this.factors.addFailedTry(tx, challengeId);
    const lockedUntil = await this.factors.countWrongCode(tx, user.id, now, {
      start: new Date(now.getTime() - MFA_LOCK.windowSeconds * 1000),
      cap: MFA_LOCK.wrongCodes,
      lockedUntil: new Date(now.getTime() + MFA_LOCK.lockSeconds * 1000),
    });
    const actor = { userId: user.id, roleCode: null, displayName: displayName(user) };
    if (lockedUntil) {
      await this.factors.spendChallenge(tx, challengeId, now);
      await this.audit.record(tx, {
        action: 'auth.mfa_account_locked',
        institutionId: null,
        societyId: null,
        outcome: AuditOutcome.Denied,
        entityType: 'user',
        entityId: user.id,
        actor,
        after: { wrongCodes: MFA_LOCK.wrongCodes, lockSeconds: MFA_LOCK.lockSeconds },
      });
      return {
        ...refused(HttpStatus.LOCKED, AuthCode.AUTH_LOCKED, undefined, MFA_LOCK.lockSeconds),
        mail: authenticatorLockoutEmail(user.email, MFA_LOCK.lockSeconds),
      };
    }
    const attemptsLeft = Math.max(0, MFA_LIMITS.triesPerToken - tries);
    if (attemptsLeft === 0) {
      await this.audit.record(tx, {
        action: 'auth.mfa_locked',
        institutionId: null,
        societyId: null,
        outcome: AuditOutcome.Denied,
        entityType: 'user',
        entityId: user.id,
        actor,
        after: { wrongCodes: tries },
      });
    }
    return refused(HttpStatus.UNAUTHORIZED, AuthCode.MFA_INVALID, { attemptsLeft });
  }
}
