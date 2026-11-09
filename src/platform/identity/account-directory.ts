import { Injectable } from '@nestjs/common';
import { RoleCode, RoleName } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { duplicateOn, type Tx } from '../database/index.js';
import { emailChangedEmail, staffMovedEmail, welcomeEmail } from './account-email.js';
import type { NewPersonDto } from './account.dto.js';
import { AccountRepository, type AccountRow } from './account.repository.js';
import { emailInUse, nextSeat, requireCanHoldRole, requireNotSelf } from './account-rules.js';
import { SessionEndReason } from './auth-codes.js';
import { BackgroundMailer } from './background-mailer.js';
import { MfaRepository } from './mfa.repository.js';
import { personName } from './person-name.js';
import { SessionRepository } from './session.repository.js';

/**
 * The reasons a grant is revoked for that a reactivation restores (Society deactivated, Institution deactivated),
 * so such a grant is access that can come back. These are the values of `SOCIETY_DEACTIVATED` and
 * `INSTITUTION_DEACTIVATED` in the Tenancy module, which cannot be imported here; a test holds them equal.
 */
export const RESTORABLE_REVOKE_REASONS = [
  'society_deactivated',
  'institution_deactivated',
] as const;

/** The seat kinds of the platform (PRD decision 19): the role code, and the Society for an Owner. */
export interface SeatKind {
  roleCode: 1 | 2;
  societyId: string | null;
}

/** A person found or made for a staff record: no seat, because roles 4 and 5 are derived from their records. */
export interface LinkedPerson {
  id: string;
  email: string;
  displayName: string;
  /** False when the email already belonged to a person, who is now also staff here. */
  created: boolean;
}

/**
 * What a change of a staff member's email did: nothing (the same email), the person's own email changed, or the
 * staff record is to move to `person` (an existing person, or a new Pending one), whose account the caller now links.
 */
export type StaffEmailChange =
  | { kind: 'unchanged'; person: LinkedPerson }
  | { kind: 'edited'; person: LinkedPerson; previousEmail: string; sessionsEnded: number }
  | { kind: 'moved'; person: LinkedPerson; previousEmail: string; sessionsEnded: number };

export interface StaffEmailChangeRequest {
  /** The person the record belongs to now, and the Society it is in. */
  userId: string;
  societyId: string;
  email: string;
  /** The names a new person's account starts with, from the record. */
  names: { firstName: string | null; lastName: string | null };
  by: string;
  now: Date;
  /** Passes or refuses an existing person the record would move to (for one who already has a record here). */
  vet: (personId: string) => Promise<void>;
}

export interface GrantedPerson {
  id: string;
  email: string;
  displayName: string;
  seatNo: number;
  /** False when the email already belonged to a person, who now holds the role as well. */
  created: boolean;
}

/**
 * Adds and removes Super Admins and Society Owners for the platform (API design
 * 10.4d). It runs in the caller's transaction, so the grant and the caller's
 * audit entry commit together; the welcome mail goes after the commit.
 */
@Injectable()
export class AccountDirectory {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly sessions: SessionRepository,
    private readonly mfa: MfaRepository,
    private readonly mailer: BackgroundMailer,
  ) {}

  /**
   * Gives a person the role by email: a new email makes a Pending account, an
   * email that already belongs to a person gives them the role (one email is
   * one person, PRD 5.2). The lowest free seat is taken; none free is 409
   * `SEAT_LIMIT_REACHED`. A person who already holds the seat kind is 409
   * `DUPLICATE`; one who holds the other platform role (Super Admin and Society
   * Owner are never the same person) is 409 `ROLE_CONFLICT`.
   */
  async grant(
    tx: Tx,
    kind: SeatKind,
    person: NewPersonDto,
    by: string,
    now: Date,
  ): Promise<GrantedPerson> {
    await this.accounts.lockSeats(tx, kind.roleCode, kind.societyId);
    const holder = await this.findOrMake(tx, person, by, async (existing) => {
      if (await this.accounts.activeGrant(tx, existing.id, kind.roleCode, kind.societyId)) {
        throw duplicateOn('email');
      }
      await this.requireSeparateRoles(tx, existing.id, kind.roleCode);
    });
    const seatNo = nextSeat(await this.accounts.takenSeats(tx, kind.roleCode, kind.societyId));
    await this.accounts.insertGrant(tx, {
      userId: holder.id,
      roleCode: kind.roleCode,
      societyId: kind.societyId,
      seatNo,
      by,
      now,
    });
    return { ...holder, seatNo };
  }

  /**
   * The person for a staff record, by email (PRD 5.2, one email is one person): a new email makes a Pending
   * account, an email that already belongs to a person is that person. A blocked or inactive person cannot be
   * given a record; a Super Admin is never staff (409 `ROLE_CONFLICT`). Runs in the caller's transaction; the
   * welcome mail is the caller's, after the commit.
   */
  async linkStaff(tx: Tx, person: NewPersonDto, by: string): Promise<LinkedPerson> {
    return this.findOrMake(tx, person, by, (existing) =>
      this.requireSeparateRoles(tx, existing.id, RoleCode.TeacherStaff),
    );
  }

  /**
   * A staff member's login email changes (API design 6.6, STF-13). When the person holds nothing but this staff
   * record, their own email changes at once: every session of theirs and every open authenticator step ends. An email that
   * belongs to a person moves the record to that person (PRD 5.2, one email is one person), once they may hold a role,
   * `vet` passes them and they are not a Super Admin. When the person holds anything else (an Owner or Admin grant, or
   * a record in another Society) a new email is not theirs to change from here, so it makes a new Pending person and
   * the record moves there; their other access stays. A record that moves ends the old person's sessions as staff of
   * this Society. Runs in the caller's transaction, with the record locked.
   */
  async changeStaffEmail(tx: Tx, request: StaffEmailChangeRequest): Promise<StaffEmailChange> {
    const email = request.email.toLowerCase();
    await this.lockIdentities(tx);
    const current = await this.accounts.findById(tx, request.userId, true);
    if (!current) throw AppException.notFound();
    if (current.email === email) return { kind: 'unchanged', person: linked(current, false) };

    const existing = await this.accounts.findByEmail(tx, email);
    if (existing) {
      requireNotSelf(request.by, existing.id);
      requireCanHoldRole(existing);
      await request.vet(existing.id);
      await this.requireSeparateRoles(tx, existing.id, RoleCode.TeacherStaff);
      return this.moved(tx, request, current, linked(existing, false));
    }
    if (await this.holdsOnlyThisRecord(tx, request)) {
      const { person, sessionsEnded } = await this.changeOwnEmail(
        tx,
        request.userId,
        email,
        request.by,
        request.now,
      );
      return {
        kind: 'edited',
        person: linked(person, false),
        previousEmail: current.email,
        sessionsEnded,
      };
    }
    const created = await this.accounts
      .insertPending(
        tx,
        { email, firstName: request.names.firstName, lastName: request.names.lastName },
        request.by,
      )
      .catch((error: unknown) => {
        throw emailInUse(error);
      });
    return this.moved(tx, request, current, linked(created, true));
  }

  private async moved(
    tx: Tx,
    request: StaffEmailChangeRequest,
    from: AccountRow,
    to: LinkedPerson,
  ): Promise<StaffEmailChange> {
    const sessionsEnded = await this.accounts.endRoleSessions(
      tx,
      from.id,
      RoleCode.TeacherStaff,
      request.societyId,
      SessionEndReason.AccessRevoked,
      request.now,
    );
    return { kind: 'moved', person: to, previousEmail: from.email, sessionsEnded };
  }

  /**
   * Takes the one identity lock (see `AccountRepository.lockRoleSeparation`): a change of a person's email holds it
   * from before it reads the person until it commits, as every lookup of a person by email does, so the two never
   * interleave. Taken after any seat lock and last of all, like the role separation check.
   */
  lockIdentities(tx: Tx): Promise<void> {
    return this.accounts.lockRoleSeparation(tx);
  }

  /**
   * The person's own email changes (PLT-17 and the edited outcome of STF-13): every session of theirs ends and every
   * open authenticator step is used up, so nothing the old address opened outlives the change. 409 `EMAIL_IN_USE`
   * when another request took the address first. Returns the person and how many sessions ended; the mails are
   * `announceEmailChange`, after the commit.
   */
  async changeOwnEmail(
    tx: Tx,
    userId: string,
    email: string,
    by: string,
    now: Date,
  ): Promise<{ person: AccountRow; sessionsEnded: number }> {
    const person = await this.accounts
      .update(tx, userId, { email, updated_by: by })
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
    return { person, sessionsEnded };
  }

  /** Tells the old and the new address of an email change, after the commit; `changedBy` names who did it. */
  announceEmailChange(previous: string, next: string, changedBy?: string): void {
    this.mailer.send(emailChangedEmail(previous, 'old', changedBy));
    this.mailer.send(emailChangedEmail(next, 'new', changedBy));
  }

  /**
   * No Super Admin, Owner or Admin grant, and no staff record outside this Society: the account is this record's
   * alone. Dormant access counts as held: a grant revoked for a reason a reactivation restores, and a record in a
   * Society or Institution that is deactivated, come back with it.
   */
  private async holdsOnlyThisRecord(tx: Tx, request: StaffEmailChangeRequest): Promise<boolean> {
    const holdsGrant = await this.accounts.holdsGrantOrRestorable(
      tx,
      request.userId,
      [RoleCode.SuperAdmin, RoleCode.SocietyOwner, RoleCode.InstitutionAdmin],
      RESTORABLE_REVOKE_REASONS,
    );
    return (
      !holdsGrant && !(await this.sessions.hasStaffElsewhere(tx, request.userId, request.societyId))
    );
  }

  /** The mails after the commit: the old address and the new one are told; a record that moved tells its old person. */
  announceStaffEmail(
    change: Exclude<StaffEmailChange, { kind: 'unchanged' }>,
    societyName: string | null,
  ): void {
    if (change.kind === 'edited') {
      this.announceEmailChange(change.previousEmail, change.person.email, 'your school');
      return;
    }
    this.mailer.send(staffMovedEmail(change.previousEmail));
    this.welcomeAs(change.person, RoleCode.TeacherStaff, societyName);
  }

  /**
   * The person an email names (one email is one person): the existing account when there is one, once it may hold a
   * role and `vet` has passed it, otherwise a new Pending account.
   */
  private async findOrMake(
    tx: Tx,
    person: NewPersonDto,
    by: string,
    vet: (existing: AccountRow) => Promise<void>,
  ): Promise<LinkedPerson> {
    const email = person.email.toLowerCase();
    // One identity change at a time: if the person's email is being changed (STF-13), this waits for it and then
    // finds nobody at the old address, so the access is never attached to a person who has just moved.
    await this.accounts.lockRoleSeparation(tx);
    const existing = await this.accounts.findByEmail(tx, email);
    if (existing) {
      requireCanHoldRole(existing);
      await vet(existing);
    }
    const holder =
      existing ??
      (await this.accounts
        .insertPending(
          tx,
          { email, firstName: person.firstName ?? null, lastName: person.lastName ?? null },
          by,
        )
        .catch((error: unknown) => {
          throw emailInUse(error);
        }));
    return linked(holder, existing === undefined);
  }

  /**
   * Ends the person's sessions that act in this role in this Society, so they lose access on the next call (a
   * staff record deactivated or blocked). Returns how many ended.
   */
  endRoleSessions(
    tx: Tx,
    userId: string,
    roleCode: RoleCode,
    societyId: string,
    now: Date,
  ): Promise<number> {
    return this.accounts.endRoleSessions(
      tx,
      userId,
      roleCode,
      societyId,
      SessionEndReason.AccessRevoked,
      now,
    );
  }

  /** Under the separation lock, so a concurrent grant of the other role sees this one or is seen by it. */
  private async requireSeparateRoles(tx: Tx, userId: string, roleCode: RoleCode): Promise<void> {
    await this.accounts.lockRoleSeparation(tx);
    const other = roleCode === RoleCode.SuperAdmin ? RoleCode.SocietyOwner : RoleCode.SuperAdmin;
    if (await this.accounts.holdsActiveGrant(tx, userId, [other])) {
      throw AppException.conflict(ErrorCode.ROLE_CONFLICT);
    }
  }

  /**
   * Takes the role from the person and ends their sessions acting in it, so
   * they lose access on the next call. 404 when they do not hold it. With
   * `lastHolder` set, the only holder of the seat kind is refused with that
   * code, decided under the seat lock so two removals cannot both win. Returns
   * how many sessions ended.
   */
  async revoke(
    tx: Tx,
    kind: SeatKind,
    userId: string,
    by: string,
    reason: string,
    now: Date,
    lastHolder?: ErrorCode,
  ): Promise<number> {
    await this.accounts.lockSeats(tx, kind.roleCode, kind.societyId);
    const grant = await this.accounts.activeGrant(tx, userId, kind.roleCode, kind.societyId);
    if (!grant) throw AppException.notFound();
    if (lastHolder) await this.requireAnotherHolder(tx, kind, lastHolder);
    await this.accounts.revokeGrant(tx, grant.id, by, reason, now);
    return this.accounts.endRoleSessions(
      tx,
      userId,
      kind.roleCode,
      kind.societyId,
      SessionEndReason.AccessRevoked,
      now,
    );
  }

  private async requireAnotherHolder(tx: Tx, kind: SeatKind, code: ErrorCode): Promise<void> {
    const taken = await this.accounts.takenSeats(tx, kind.roleCode, kind.societyId);
    if (taken.length < 2) throw AppException.conflict(code);
  }

  /** The welcome mail, after the commit; a failed send never undoes the grant. */
  welcome(person: GrantedPerson, kind: SeatKind, societyName: string | null): void {
    this.welcomeAs(person, kind.roleCode, societyName);
  }

  /** The same mail for a role that has no seat, such as a teacher. */
  welcomeAs(person: { email: string }, roleCode: RoleCode, societyName: string | null): void {
    this.mailer.send(welcomeEmail(person.email, RoleName[roleCode], societyName));
  }
}

function linked(holder: AccountRow, created: boolean): LinkedPerson {
  return {
    id: holder.id,
    email: holder.email,
    displayName: personName(holder.first_name, holder.last_name) ?? holder.email,
    created,
  };
}
