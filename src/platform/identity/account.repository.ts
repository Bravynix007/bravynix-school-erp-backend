import { Injectable } from '@nestjs/common';
import { sql, type Selectable, type Updateable } from 'kysely';
import { newId } from '../../common/ids/ids.js';
import type { Db, Tx } from '../database/index.js';
import { AccountStatus } from './auth-codes.js';
import type { RoleAssignmentsTable, UsersTable } from './identity.tables.js';

export type AccountRow = Selectable<UsersTable>;
export type GrantRow = Selectable<RoleAssignmentsTable>;

/** A seat holder: the person, the seat and when the grant was made. */
export interface SeatHolder {
  user: AccountRow;
  seatNo: number;
  grantedAt: Date;
}

/**
 * People and their grants, for the platform's account management (PLT-09 to
 * PLT-18, API design 10.4d). Only the Identity module touches these tables.
 */
@Injectable()
export class AccountRepository {
  async findByEmail(db: Db, email: string): Promise<AccountRow | undefined> {
    return db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
  }

  /** The person, optionally locked for the rest of the transaction. */
  async findById(db: Db, id: string, lock = false): Promise<AccountRow | undefined> {
    const query = db.selectFrom('users').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  async insertPending(
    tx: Tx,
    person: { email: string; firstName: string | null; lastName: string | null },
    by: string,
  ): Promise<AccountRow> {
    return tx
      .insertInto('users')
      .values({
        id: newId(),
        email: person.email,
        first_name: person.firstName,
        last_name: person.lastName,
        account_status: AccountStatus.Pending,
        created_by: by,
        updated_by: by,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * One at a time per kind of seat, so two requests cannot both take the last
   * seat or both remove the last Super Admin. Released when the transaction ends.
   */
  async lockSeats(tx: Tx, roleCode: number, societyId: string | null): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`grants:${String(roleCode)}:${societyId ?? 'platform'}`}, 0))`.execute(
      tx,
    );
  }

  /**
   * One grant at a time per person, so a Super Admin grant and an Owner grant
   * for the same person cannot both pass the separation check (PRD 5.2). Taken
   * after the seat lock, always in that order. Released when the transaction ends.
   */
  async lockPerson(tx: Tx, userId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`person:${userId}`}, 0))`.execute(tx);
  }

  async takenSeats(tx: Tx, roleCode: number, societyId: string | null): Promise<number[]> {
    const rows = await tx
      .selectFrom('role_assignments')
      .select('seat_no')
      .where('role_code', '=', roleCode)
      .where('society_id', societyId === null ? 'is' : '=', societyId)
      .where('revoked_at', 'is', null)
      .execute();
    return rows.flatMap((row) => (row.seat_no === null ? [] : [row.seat_no]));
  }

  async insertGrant(
    tx: Tx,
    grant: {
      userId: string;
      roleCode: number;
      societyId: string | null;
      seatNo: number;
      by: string;
      now: Date;
    },
  ): Promise<void> {
    await tx
      .insertInto('role_assignments')
      .values({
        user_id: grant.userId,
        role_code: grant.roleCode,
        society_id: grant.societyId,
        seat_no: grant.seatNo,
        created_by: grant.by,
        created_at: grant.now,
      })
      .execute();
  }

  /** The person's active grant of this role in this Society (`null` for Super Admin), if any. */
  async activeGrant(
    tx: Tx,
    userId: string,
    roleCode: number,
    societyId: string | null,
  ): Promise<GrantRow | undefined> {
    return tx
      .selectFrom('role_assignments')
      .selectAll()
      .where('user_id', '=', userId)
      .where('role_code', '=', roleCode)
      .where('society_id', societyId === null ? 'is' : '=', societyId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
  }

  async holdsActiveGrant(db: Db, userId: string, roleCodes: readonly number[]): Promise<boolean> {
    const row = await db
      .selectFrom('role_assignments')
      .select('id')
      .where('user_id', '=', userId)
      .where('role_code', 'in', roleCodes)
      .where('revoked_at', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async revokeGrant(tx: Tx, grantId: string, by: string, reason: string, now: Date): Promise<void> {
    await tx
      .updateTable('role_assignments')
      .set({ revoked_at: now, revoked_by: by, revoke_reason: reason })
      .where('id', '=', grantId)
      .execute();
  }

  /** The people who hold an active grant of this role (`societyId` `null` for Super Admin), by seat. */
  async seatHolders(db: Db, roleCode: number, societyId: string | null): Promise<SeatHolder[]> {
    const rows = await db
      .selectFrom('role_assignments as grant')
      .innerJoin('users', 'users.id', 'grant.user_id')
      .selectAll('users')
      .select(['grant.seat_no as seat_no', 'grant.created_at as granted_at'])
      .where('grant.role_code', '=', roleCode)
      .where('grant.society_id', societyId === null ? 'is' : '=', societyId)
      .where('grant.revoked_at', 'is', null)
      .orderBy('grant.seat_no')
      .execute();
    return rows.map(({ seat_no, granted_at, ...user }) => ({
      user,
      seatNo: seat_no ?? 0,
      grantedAt: granted_at,
    }));
  }

  /** Ends the person's open sessions that act in this role and Society. Returns how many. */
  async endRoleSessions(
    tx: Tx,
    userId: string,
    roleCode: number,
    societyId: string | null,
    reason: number,
    now: Date,
  ): Promise<number> {
    const result = await tx
      .updateTable('auth_sessions')
      .set({ ended_at: now, end_reason: reason })
      .where('user_id', '=', userId)
      .where('active_role_code', '=', roleCode)
      .where('active_society_id', societyId === null ? 'is' : '=', societyId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async update(tx: Tx, userId: string, columns: Updateable<UsersTable>): Promise<AccountRow> {
    return tx
      .updateTable('users')
      .set(columns)
      .where('id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
