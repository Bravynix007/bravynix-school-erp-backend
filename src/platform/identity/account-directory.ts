import { Injectable } from '@nestjs/common';
import { RoleCode, RoleName } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { duplicateOn, type Tx } from '../database/index.js';
import { welcomeEmail } from './account-email.js';
import type { NewPersonDto } from './account.dto.js';
import { AccountRepository } from './account.repository.js';
import { emailInUse, nextSeat, requireCanHoldRole } from './account-rules.js';
import { SessionEndReason } from './auth-codes.js';
import { BackgroundMailer } from './background-mailer.js';
import { personName } from './person-name.js';

/** The seat kinds of the platform (PRD decision 19): the role code, and the Society for an Owner. */
export interface SeatKind {
  roleCode: 1 | 2;
  societyId: string | null;
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
    const email = person.email.toLowerCase();
    await this.accounts.lockSeats(tx, kind.roleCode, kind.societyId);
    const existing = await this.accounts.findByEmail(tx, email);
    if (existing) {
      requireCanHoldRole(existing);
      if (await this.accounts.activeGrant(tx, existing.id, kind.roleCode, kind.societyId)) {
        throw duplicateOn('email');
      }
      await this.requireSeparateRoles(tx, existing.id, kind.roleCode);
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
    const seatNo = nextSeat(await this.accounts.takenSeats(tx, kind.roleCode, kind.societyId));
    await this.accounts.insertGrant(tx, {
      userId: holder.id,
      roleCode: kind.roleCode,
      societyId: kind.societyId,
      seatNo,
      by,
      now,
    });
    return {
      id: holder.id,
      email: holder.email,
      displayName: personName(holder.first_name, holder.last_name) ?? holder.email,
      seatNo,
      created: existing === undefined,
    };
  }

  /** Under the person lock, so a concurrent grant of the other role sees this one or is seen by it. */
  private async requireSeparateRoles(
    tx: Tx,
    userId: string,
    roleCode: SeatKind['roleCode'],
  ): Promise<void> {
    await this.accounts.lockPerson(tx, userId);
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
    this.mailer.send(welcomeEmail(person.email, RoleName[kind.roleCode], societyName));
  }
}
