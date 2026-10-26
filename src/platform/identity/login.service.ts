import { HttpStatus, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { newId } from '../../common/ids/ids.js';
import { RequestContext } from '../../common/request-context/request-context.js';
import { Clock } from '../../common/time/clock.js';
import { AuditOutcome, AuditService } from '../audit/index.js';
import { DatabaseService, type Tx } from '../database/index.js';
import { AccountStatus, AuthCode, ClientType, reportedStatus, userTypeFor } from './auth-codes.js';
import { mobileContexts, onlyContext, type Context } from './contexts.js';
import { BackgroundMailer } from './background-mailer.js';
import {
  canReceiveCode,
  IdentityRepository,
  type LiveChallenge,
  type LoginUser,
  NIL_UUID,
} from './identity.repository.js';
import { lockoutEmail } from './lockout-email.js';
import { OtpHasher } from './otp-hasher.js';
import { lockSecondsFor, OTP_LIMITS } from './otp-limits.js';
import { PublicCallLimiter } from './public-call-limiter.js';
import { MOBILE_SESSION_MS } from './session-rules.js';
import { requestIp } from './request-ip.js';
import { SessionRepository } from './session.repository.js';
import { latest, secondsUntil } from './time-rules.js';
import type { EmailMessage } from '../email/email-sender.js';
import { TokenService } from './token.service.js';
import type { DeviceDto } from './verify-otp.dto.js';

export interface VerifyRequest {
  email: string;
  code: string;
  clientType: ClientType;
  device?: DeviceDto;
}

export interface LoginResult {
  userType: number | null;
  userTypeName: string | null;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  session: { id: string; activeContext: { roleCode: number; societyId: string | null } | null };
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

const NO_CODE = Buffer.alloc(32);

type Refused = { kind: 'refused'; error: AppException; mail?: EmailMessage };
type Outcome =
  | Refused
  | {
      kind: 'signedIn';
      user: LoginUser;
      sessionId: string;
      contexts: Context[];
      active: Context | null;
    };

/**
 * AUTH-02: verify a login code and start a session (API design 10.2, DDD
 * 13.1). The wrong-try count and the lock are kept per email, over all live
 * codes (30 minutes, and 24 hours from the third lockout within 24 hours), and the answers for an unknown email are the same as for a
 * registered one, so no answer tells them apart (I-07).
 *
 * Mobile sessions only for now: a Super Admin on the console also needs the
 * authenticator step (slice B8) and is not given a session here.
 */
@Injectable()
export class LoginService {
  constructor(
    private readonly database: DatabaseService,
    private readonly identity: IdentityRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly hasher: OtpHasher,
    private readonly tokens: TokenService,
    private readonly limiter: PublicCallLimiter,
    private readonly mailer: BackgroundMailer,
  ) {}

  async verify(request: VerifyRequest): Promise<LoginResult> {
    const email = request.email.trim().toLowerCase();
    const ip = requestIp();
    // First, before a connection is held for anything else: every call counts.
    await this.limiter.check(ip);

    const refresh = this.tokens.newRefreshToken();
    const outcome = await this.database.transaction({}, (tx) =>
      this.verifyInTransaction(tx, email, request, ip, refresh.hmac),
    );
    // Wrong codes are saved above, so the refusal is raised only after the commit.
    if (outcome.kind === 'refused') {
      // After the commit, off the request: the answer is the same with or without an account.
      if (outcome.mail) this.mailer.send(outcome.mail);
      throw outcome.error;
    }

    const { user, sessionId, contexts, active } = outcome;
    const signed = await this.tokens.signAccessToken(
      {
        personId: user.id,
        sessionId,
        roleCode: active?.roleCode ?? null,
        societyId: active?.societyId ?? null,
        clientType: request.clientType === ClientType.Mobile ? 'mobile' : 'console',
      },
      this.clock.now(),
    );
    return {
      ...userTypeFor(active?.roleCode ?? null),
      accessToken: signed.token,
      accessTokenExpiresAt: signed.expiresAt.toISOString(),
      refreshToken: refresh.token,
      session: {
        id: sessionId,
        activeContext: active ? { roleCode: active.roleCode, societyId: active.societyId } : null,
      },
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

  private async verifyInTransaction(
    tx: Tx,
    email: string,
    request: VerifyRequest,
    ip: string | null,
    refreshHmac: Buffer,
  ): Promise<Outcome> {
    const now = this.clock.now();
    const emailHmac = this.hasher.email(email);

    // One attempt at a time per email, so two parallel guesses cannot both be
    // counted as the first. A busy email is answered at once, without waiting.
    if (!(await this.identity.tryLockEmail(tx, emailHmac))) {
      return {
        kind: 'refused',
        error: new AppException(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED, {
          retryAfterSeconds: 1,
        }),
      };
    }

    const user = await this.identity.findUserByEmail(tx, email);
    const lockedUntil = latest(
      user?.lockedUntil,
      await this.identity.activeChallengeLock(tx, emailHmac, now),
    );
    if (lockedUntil && lockedUntil > now) {
      return refused(HttpStatus.LOCKED, AuthCode.AUTH_LOCKED, secondsUntil(lockedUntil, now));
    }

    const live = await this.identity.liveChallenges(tx, emailHmac, now);
    // Nothing to try: never asked, used, replaced, expired or out of tries.
    if (live.length === 0) return refused(HttpStatus.UNAUTHORIZED, AuthCode.OTP_EXPIRED);

    const matched = this.findMatch(live, email, request.code);
    if (!matched) return this.recordWrongCode(tx, emailHmac, user, live, now);

    // From here the code was right; only the mailbox owner can hold it.
    if (!user || matched.userId !== user.id) {
      // Cannot happen (a code is only stored for an account); refuse like a wrong code.
      return this.recordWrongCode(tx, emailHmac, user, live, now);
    }
    if (user.accountStatus === AccountStatus.Blocked) {
      await this.identity.consumeChallenge(tx, emailHmac, matched.id, now);
      await this.identity.clearFailures(tx, user.id);
      return refused(HttpStatus.FORBIDDEN, AuthCode.ACCOUNT_BLOCKED);
    }

    const allGrants = await this.sessions.activeGrants(tx, user.id);
    if (request.clientType === ClientType.Console) {
      if (!allGrants.some((grant) => grant.roleCode === 1)) {
        await this.identity.consumeChallenge(tx, emailHmac, matched.id, now);
        await this.identity.clearFailures(tx, user.id);
        return refused(HttpStatus.FORBIDDEN, AuthCode.CONSOLE_NOT_ALLOWED);
      }
      // A Super Admin also needs the authenticator step (B8); the code is kept for it.
      return refused(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_UNAVAILABLE);
    }

    await this.identity.consumeChallenge(tx, emailHmac, matched.id, now);
    await this.identity.recordLogin(tx, user.id, now);

    // One context starts the session in it; several wait for the role chooser (AUTH-06).
    const contexts = mobileContexts(allGrants);
    const active = onlyContext(contexts);
    const sessionId = newId();
    await this.sessions.createSession(tx, {
      id: sessionId,
      userId: user.id,
      clientType: ClientType.Mobile,
      activeRoleCode: active?.roleCode ?? null,
      activeSocietyId: active?.societyId ?? null,
      now,
      idleExpiresAt: new Date(now.getTime() + MOBILE_SESSION_MS),
      absoluteExpiresAt: null,
      ip,
      userAgent: RequestContext.current()?.userAgent?.slice(0, 300) ?? null,
      deviceLabel: request.device?.label ?? null,
    });
    await this.sessions.insertRefreshToken(tx, {
      id: newId(),
      sessionId,
      hmac: refreshHmac,
      expiresAt: new Date(now.getTime() + MOBILE_SESSION_MS),
      now,
    });
    await this.audit.record(tx, {
      action: 'auth.login',
      institutionId: null,
      societyId: null,
      entityType: 'user',
      entityId: user.id,
      actor: {
        userId: user.id,
        roleCode: active?.roleCode ?? null,
        displayName: displayName(user),
      },
      after: { channel: 'mobile', platform: request.device?.platform ?? null },
    });
    return { kind: 'signedIn', user, sessionId, contexts, active };
  }

  /**
   * Compares the code with every live code, whatever the first comparison
   * says, so the time taken does not show which code matched or how many
   * there were.
   */
  private findMatch(live: LiveChallenge[], email: string, code: string): LiveChallenge | null {
    const submitted = this.hasher.code(email, code);
    let matched: LiveChallenge | null = null;
    for (const challenge of live) {
      const equal = timingSafeEqual(submitted, challenge.codeHmac ?? NO_CODE);
      if (equal && challenge.codeHmac !== null && matched === null) matched = challenge;
    }
    return matched;
  }

  private async recordWrongCode(
    tx: Tx,
    emailHmac: Buffer,
    user: LoginUser | undefined,
    live: LiveChallenge[],
    now: Date,
  ): Promise<Outcome> {
    const tries = Math.max(...live.map((challenge) => challenge.attemptCount)) + 1;
    const locked = tries >= OTP_LIMITS.attemptsPerCode;
    // Every live code shows the same count; at the limit they are all out of tries.
    await this.identity.setAttemptCount(
      tx,
      live.map((c) => c.id),
      tries,
    );
    if (locked) {
      const since = new Date(now.getTime() - OTP_LIMITS.lockoutWindowSeconds * 1000);
      // This lockout counts too; the email is held by the lock taken at the start, so the count is exact.
      const lockouts = (await this.identity.lockoutsSince(tx, emailHmac, since)) + 1;
      const lockSeconds = lockSecondsFor(lockouts);
      const until = new Date(now.getTime() + lockSeconds * 1000);
      await this.identity.recordLockout(tx, emailHmac, until, now);
      await this.identity.lockChallenges(tx, emailHmac, until, since);
      // The update runs for an unknown email too (a nil id matches no row), so the work is the same.
      await this.identity.setUserFailures(tx, user?.id ?? NIL_UUID, 0, until);
      // The same entry for a registered and an unknown email.
      await this.audit.record(tx, {
        action: 'auth.lockout',
        institutionId: null,
        societyId: null,
        outcome: AuditOutcome.Denied,
        ...(user ? { entityType: 'user', entityId: user.id } : {}),
        actor: { userId: null, roleCode: null, displayName: null },
        after: { lockoutsIn24Hours: lockouts, lockSeconds },
      });
      const outcome = refused(HttpStatus.UNAUTHORIZED, AuthCode.OTP_ATTEMPTS_EXCEEDED, lockSeconds);
      // Only a registered person is told; an unknown email gets no mail.
      return user && canReceiveCode(user.accountStatus)
        ? { ...outcome, mail: lockoutEmail(user.email, lockSeconds) }
        : outcome;
    }
    await this.identity.setUserFailures(tx, user?.id ?? NIL_UUID, tries, null);
    return {
      kind: 'refused',
      error: new AppException(HttpStatus.UNAUTHORIZED, AuthCode.OTP_INVALID, {
        details: { attemptsLeft: OTP_LIMITS.attemptsPerCode - tries },
      }),
    };
  }
}

function refused(status: HttpStatus, code: string, retryAfterSeconds?: number): Refused {
  return { kind: 'refused', error: new AppException(status, code, { retryAfterSeconds }) };
}

function displayName(user: LoginUser): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || null;
}
