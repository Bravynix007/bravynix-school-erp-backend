import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { newId } from '../../common/ids/ids.js';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app-config.js';
import { DatabaseService } from '../database/index.js';
import { AuthCode, ClientType } from './auth-codes.js';
import { BackgroundMailer } from './background-mailer.js';
import { canReceiveCode, IdentityRepository, NIL_UUID } from './identity.repository.js';
import { otpEmail } from './otp-email.js';
import { OtpHasher, generateOtpCode } from './otp-hasher.js';
import { evaluateOtpRequest, OTP_LIMITS } from './otp-limits.js';
import { PublicCallLimiter } from './public-call-limiter.js';
import { requestIp } from './request-ip.js';
import { latest } from './time-rules.js';

export interface OtpRequest {
  email: string;
  clientType: ClientType;
}

export interface OtpRequestResult {
  /** Only when development echo is on and the account is registered. */
  devCode?: string;
}

/**
 * AUTH-01: request a login code (API design 10.1).
 *
 * The answer must not depend on whether the email has an account (PRD 5.1,
 * I-07). So an unknown email takes the same path: the same limits are checked,
 * and a challenge row is stored; only the code and the email are missing. The
 * mail is sent after the answer is decided, off the request, so the time taken
 * does not tell the two cases apart either.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: IdentityRepository,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly mailer: BackgroundMailer,
    private readonly hasher: OtpHasher,
    private readonly limiter: PublicCallLimiter,
  ) {}

  async requestCode(request: OtpRequest): Promise<OtpRequestResult> {
    const email = request.email.trim().toLowerCase();
    const emailHmac = this.hasher.email(email);
    const ip = requestIp();
    // First, before a connection is held for anything else: every call counts.
    await this.limiter.check(ip);

    const issued = await this.database.transaction({}, async (tx) => {
      const now = this.clock.now();
      // One request at a time per email, so two parallel requests cannot both
      // pass the limits. A request that finds another one running would meet
      // the 60-second gap anyway, so it is answered at once instead of
      // holding a connection; the answer is the same for every email.
      if (!(await this.repository.tryLockEmail(tx, emailHmac))) {
        throw new AppException(HttpStatus.TOO_MANY_REQUESTS, AuthCode.OTP_RESEND_TOO_SOON, {
          retryAfterSeconds: OTP_LIMITS.resendGapSeconds,
        });
      }
      const user = await this.repository.findUserByEmail(tx, email);

      const windowStart = new Date(now.getTime() - OTP_LIMITS.requestWindowSeconds * 1000);
      const requests = await this.repository.emailRequestTimes(tx, emailHmac, ip, windowStart);
      const challengeLock = await this.repository.activeChallengeLock(tx, emailHmac, now);

      const refusal = evaluateOtpRequest({
        now,
        emailRequests: requests.map((r) => r.at),
        addressRequests: requests.filter((r) => r.sameAddress).map((r) => r.at),
        lockedUntil: latest(user?.lockedUntil, challengeLock),
      });
      if (refusal) {
        throw new AppException(refusal.status, refusal.code, {
          retryAfterSeconds: refusal.retryAfterSeconds,
        });
      }

      // A code goes to an account that can sign in, and for the console only
      // to a Super Admin. Anything else gets the same answer and no mail.
      // The grant is looked up for every console request, with a nil id when
      // there is no account, so the work does not depend on the email.
      const superAdmin =
        request.clientType === ClientType.Console &&
        (await this.repository.hasActiveSuperAdminGrant(tx, user?.id ?? NIL_UUID));
      const eligible =
        user !== undefined &&
        canReceiveCode(user.accountStatus) &&
        (request.clientType === ClientType.Mobile || superAdmin);

      const code = eligible ? generateOtpCode() : null;
      await this.repository.supersedeLive(tx, emailHmac, ip, now);
      await this.repository.insertChallenge(tx, {
        id: newId(),
        createdAt: now,
        expiresAt: new Date(now.getTime() + OTP_LIMITS.codeLifeSeconds * 1000),
        emailHmac,
        userId: eligible ? user.id : null,
        codeHmac: code === null ? null : this.hasher.code(email, code),
        requestIp: ip,
      });
      return code;
    });

    if (issued === null) return {};
    this.mailer.send(otpEmail(email, issued));
    return this.config.env.OTP_DEV_ECHO ? { devCode: issued } : {};
  }

  /** Waits for mail still being sent. For tests. */
  async flush(): Promise<void> {
    await this.mailer.flush();
  }
}
