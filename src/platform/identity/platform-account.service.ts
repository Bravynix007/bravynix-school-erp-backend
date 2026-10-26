import { HttpStatus, Injectable } from '@nestjs/common';
import { RoleCode } from '../../common/auth/roles.js';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { ApiResult } from '../../common/http/api-result.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService, type AuditValues } from '../audit/index.js';
import { DatabaseService, platformTenant, type Tx } from '../database/index.js';
import {
  accountBlockedEmail,
  authenticatorResetEmail,
  emailChangedEmail,
} from './account-email.js';
import { AccountDirectory, type SeatKind } from './account-directory.js';
import { emailInUse, maskEmail, requireNotSelf } from './account-rules.js';
import type { NewPersonDto, ChangeEmailDto } from './account.dto.js';
import { AccountRepository, type AccountRow } from './account.repository.js';
import {
  accountResource,
  superAdminResource,
  type AccountResource,
  type SuperAdminResource,
} from './account.resource.js';
import { AccountStatus, AuthCode, SessionEndReason } from './auth-codes.js';
import { BackgroundMailer } from './background-mailer.js';
import { IdentityRepository } from './identity.repository.js';
import { MfaRepository } from './mfa.repository.js';
import { OtpHasher } from './otp-hasher.js';
import { SessionRepository } from './session.repository.js';
import type { VersionedReasonDto, ReasonDto } from '../../common/validation/reason.dto.js';
import type { VersionDto } from '../../common/validation/version.dto.js';

/** Why a Super Admin's grant was revoked. */
const SUPER_ADMIN_REMOVED = 'super_admin_removed';

const SUPER_ADMIN_SEAT: SeatKind = { roleCode: RoleCode.SuperAdmin, societyId: null };

/** What the audit log keeps of an account: its status, never an unmasked email (API design 10.4d). */
function auditView(user: AccountRow): AuditValues {
  return { account_status: user.account_status, email: maskEmail(user.email) };
}

/**
 * PLT-12 to PLT-18 and PLT-41 (API design 10.4d): Super Admin looks after the
 * platform's accounts. Every change runs in one transaction with its audit
 * entry; the person is locked for the check of `version` and state, so two
 * admins cannot both win. Mails go out after the commit.
 */
@Injectable()
export class PlatformAccountService {
  constructor(
    private readonly database: DatabaseService,
    private readonly accounts: AccountRepository,
    private readonly directory: AccountDirectory,
    private readonly sessions: SessionRepository,
    private readonly mfa: MfaRepository,
    private readonly identity: IdentityRepository,
    private readonly hasher: OtpHasher,
    private readonly mailer: BackgroundMailer,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** PLT-12. At most three, so the list is not paged. */
  async listSuperAdmins(principal: Principal): Promise<ApiResult<SuperAdminResource[]>> {
    const holders = await this.database.transaction(platformTenant(principal), (tx) =>
      this.accounts.seatHolders(tx, RoleCode.SuperAdmin, null),
    );
    const confirmed = await this.mfa.confirmedAmong(
      this.database.db,
      holders.map((holder) => holder.user.id),
    );
    return ApiResult.list(
      holders.map((holder) => superAdminResource(holder, confirmed.has(holder.user.id))),
      null,
    );
  }

  /** PLT-13. */
  async addSuperAdmin(principal: Principal, body: NewPersonDto): Promise<SuperAdminResource> {
    const now = this.clock.now();
    const granted = await this.database.transaction(platformTenant(principal), async (tx) => {
      const person = await this.directory.grant(
        tx,
        SUPER_ADMIN_SEAT,
        body,
        principal.personId,
        now,
      );
      await this.record(tx, 'super_admin.add', person.id, {
        after: { email: maskEmail(person.email), seat_no: person.seatNo },
      });
      return person;
    });
    this.directory.welcome(granted, SUPER_ADMIN_SEAT, null);
    const user = await this.mustFind(this.database.db, granted.id);
    const confirmed = await this.mfa.confirmedAmong(this.database.db, [user.id]);
    return superAdminResource(
      { user, seatNo: granted.seatNo, grantedAt: now },
      confirmed.has(user.id),
    );
  }

  /** PLT-14. The last Super Admin cannot go: the caller must still hold the role, and may not remove themself. */
  async removeSuperAdmin(principal: Principal, userId: string): Promise<{ id: string; status: 0 }> {
    requireNotSelf(principal.personId, userId);
    await this.database.transaction(platformTenant(principal), async (tx) => {
      await this.holdSuperAdminSeats(tx, principal);
      const sessionsEnded = await this.directory.revoke(
        tx,
        SUPER_ADMIN_SEAT,
        userId,
        principal.personId,
        SUPER_ADMIN_REMOVED,
        this.clock.now(),
      );
      await this.record(tx, 'super_admin.remove', userId, {
        after: { sessions_ended: sessionsEnded },
      });
    });
    return { id: userId, status: 0 };
  }

  /** PLT-15. Ends every session of the person and tells them. */
  async block(
    principal: Principal,
    userId: string,
    body: VersionedReasonDto,
  ): Promise<AccountResource> {
    const now = this.clock.now();
    const blocked = await this.database.transaction(platformTenant(principal), async (tx) => {
      // Before the person's row: two admins blocking each other run one after the other.
      await this.holdSuperAdminSeats(tx, principal);
      const current = await this.lockedAt(tx, userId, body.version);
      requireNotSelf(principal.personId, userId);
      if (
        current.account_status !== AccountStatus.Active &&
        current.account_status !== AccountStatus.Pending
      ) {
        throw AppException.conflict(ErrorCode.INVALID_STATE);
      }
      const updated = await this.accounts.update(tx, userId, {
        account_status: AccountStatus.Blocked,
        blocked_at: now,
        blocked_by: principal.personId,
        block_reason: body.reason,
        updated_by: principal.personId,
      });
      const sessionsEnded = await this.sessions.endUserSessions(
        tx,
        userId,
        SessionEndReason.AccountBlocked,
        now,
      );
      await this.record(tx, 'account.block', userId, {
        reason: body.reason,
        before: auditView(current),
        after: { ...auditView(updated), sessions_ended: sessionsEnded },
      });
      return updated;
    });
    this.mailer.send(accountBlockedEmail(blocked.email));
    return accountResource(blocked);
  }

  /** PLT-16. A person who never signed in is Pending again, the rest Active. */
  async unblock(principal: Principal, userId: string, body: VersionDto): Promise<AccountResource> {
    const unblocked = await this.database.transaction(platformTenant(principal), async (tx) => {
      const current = await this.lockedAt(tx, userId, body.version);
      if (current.account_status !== AccountStatus.Blocked) {
        throw AppException.conflict(ErrorCode.INVALID_STATE);
      }
      const updated = await this.accounts.update(tx, userId, {
        account_status:
          current.first_login_at === null ? AccountStatus.Pending : AccountStatus.Active,
        blocked_at: null,
        blocked_by: null,
        block_reason: null,
        updated_by: principal.personId,
      });
      await this.record(tx, 'account.unblock', userId, {
        before: auditView(current),
        after: auditView(updated),
      });
      return updated;
    });
    return accountResource(unblocked);
  }

  /**
   * PLT-17. Takes effect at once: every session and open authenticator step of
   * the person ends, and the old and the new address are told. An email that
   * belongs to another person is refused (staff and guardian moves arrive with
   * the People module).
   */
  async changeEmail(
    principal: Principal,
    userId: string,
    body: ChangeEmailDto,
  ): Promise<AccountResource> {
    const now = this.clock.now();
    const email = body.email.toLowerCase();
    const result = await this.database.transaction(platformTenant(principal), async (tx) => {
      const current = await this.lockedAt(tx, userId, body.version);
      if (
        !(await this.accounts.holdsActiveGrant(tx, userId, [
          RoleCode.SuperAdmin,
          RoleCode.SocietyOwner,
        ]))
      ) {
        throw AppException.notFound();
      }
      requireNotSelf(principal.personId, userId);
      if (current.email === email) return { user: current, previous: null };
      if (await this.accounts.findByEmail(tx, email)) {
        throw AppException.conflict(ErrorCode.EMAIL_IN_USE);
      }
      const updated = await this.accounts
        .update(tx, userId, { email, updated_by: principal.personId })
        .catch((error: unknown) => {
          throw emailInUse(error);
        });
      const sessionsEnded = await this.sessions.endUserSessions(
        tx,
        userId,
        SessionEndReason.EmailChanged,
        now,
      );
      await this.mfa.spendTokens(tx, userId, now);
      await this.record(tx, 'account.email_change', userId, {
        before: { email: maskEmail(current.email) },
        after: { email: maskEmail(email), sessions_ended: sessionsEnded },
      });
      return { user: updated, previous: current.email };
    });
    if (result.previous !== null) {
      this.mailer.send(emailChangedEmail(result.previous, 'old'));
      this.mailer.send(emailChangedEmail(result.user.email, 'new'));
    }
    return accountResource(result.user);
  }

  /**
   * PLT-18. Refused while the authenticator is locked: a lock is lifted by the
   * support unlock (PLT-41), not by a reset, so a stranger with the mailbox
   * cannot use the reset to start over.
   */
  async resetAuthenticator(
    principal: Principal,
    userId: string,
  ): Promise<{ id: string; authenticatorSetUp: false }> {
    const now = this.clock.now();
    const email = await this.database.transaction(platformTenant(principal), async (tx) => {
      const user = await this.mustLock(tx, userId);
      requireNotSelf(principal.personId, userId);
      if (!(await this.accounts.activeGrant(tx, userId, RoleCode.SuperAdmin, null))) {
        throw AppException.notFound();
      }
      const factor = await this.mfa.findFactor(tx, userId);
      if (!factor) throw AppException.conflict(AuthCode.MFA_NOT_ENROLLED);
      if (factor.lockedUntil !== null && factor.lockedUntil > now) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.AUTHENTICATOR_LOCKED, {
          details: { lockedUntil: factor.lockedUntil.toISOString() },
        });
      }
      await this.mfa.deleteFactor(tx, userId);
      await this.mfa.spendTokens(tx, userId, now);
      const sessionsEnded = await this.sessions.endUserSessions(
        tx,
        userId,
        SessionEndReason.AccessRevoked,
        now,
      );
      await this.record(tx, 'mfa.reset', userId, {
        before: { authenticator_set_up: factor.confirmedAt !== null },
        after: { authenticator_set_up: false, sessions_ended: sessionsEnded },
      });
      return user.email;
    });
    this.mailer.send(authenticatorResetEmail(email));
    return { id: userId, authenticatorSetUp: false };
  }

  /**
   * PLT-41, the support unlock (R1): lifts a lock on the person's email after
   * wrong login codes and a lock on their authenticator, for a person who
   * cannot wait. The lockout history stays, so repeated lockouts still count.
   */
  async unlock(
    principal: Principal,
    userId: string,
    body: ReasonDto,
  ): Promise<{ id: string; loginLockCleared: boolean; authenticatorLockCleared: boolean }> {
    const now = this.clock.now();
    const cleared = await this.database.transaction(platformTenant(principal), async (tx) => {
      const user = await this.mustLock(tx, userId);
      const loginLockCleared = await this.identity.liftLoginLock(
        tx,
        {
          emailHmac: this.hasher.email(user.email),
          user: { id: userId, lockedUntil: user.locked_until },
          by: principal.personId,
        },
        now,
      );
      const factor = await this.mfa.findFactor(tx, userId);
      const lockedUntil = factor?.lockedUntil ?? null;
      const authenticatorLockCleared = lockedUntil !== null && lockedUntil > now;
      if (authenticatorLockCleared) await this.mfa.clearLock(tx, userId);
      if (!loginLockCleared && !authenticatorLockCleared) {
        throw AppException.conflict(ErrorCode.NOT_LOCKED);
      }
      await this.record(tx, 'account.unlock', userId, {
        reason: body.reason,
        after: {
          login_lock_cleared: loginLockCleared,
          authenticator_lock_cleared: authenticatorLockCleared,
        },
      });
      return { loginLockCleared, authenticatorLockCleared };
    });
    return { id: userId, ...cleared };
  }

  /**
   * Takes the Super Admin seats and checks the caller is still an active Super
   * Admin. A block or a removal that raced theirs and won makes them stop here,
   * so two admins acting on each other at once can never leave none.
   */
  private async holdSuperAdminSeats(tx: Tx, principal: Principal): Promise<void> {
    await this.accounts.lockSeats(tx, RoleCode.SuperAdmin, null);
    const caller = await this.accounts.findById(tx, principal.personId);
    const stillAdmin = await this.accounts.activeGrant(
      tx,
      principal.personId,
      RoleCode.SuperAdmin,
      null,
    );
    if (!stillAdmin || caller?.account_status !== AccountStatus.Active) {
      throw AppException.forbidden();
    }
  }

  /** The person, locked, with the version the client read; 404 when there is no such person. */
  private async lockedAt(tx: Tx, userId: string, version: number): Promise<AccountRow> {
    const user = await this.mustLock(tx, userId);
    requireVersion(user, version);
    return user;
  }

  private async mustLock(tx: Tx, userId: string): Promise<AccountRow> {
    const user = await this.accounts.findById(tx, userId, true);
    if (!user) throw AppException.notFound();
    return user;
  }

  private async mustFind(db: Tx | DatabaseService['db'], userId: string): Promise<AccountRow> {
    const user = await this.accounts.findById(db, userId);
    if (!user) throw AppException.notFound();
    return user;
  }

  /** Account actions belong to no Society, so they are not in any Society's audit view. */
  private record(
    tx: Tx,
    action: string,
    userId: string,
    values: { reason?: string; before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: null,
      societyId: null,
      entityType: 'user',
      entityId: userId,
      ...values,
    });
  }
}
