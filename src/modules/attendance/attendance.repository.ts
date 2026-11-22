import { Injectable } from '@nestjs/common';
import { sql, type Insertable, type Selectable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { AttendanceExceptionsTable, AttendanceSessionsTable } from './attendance.tables.js';

export type SessionRow = Selectable<AttendanceSessionsTable>;
export type NewSession = Insertable<AttendanceSessionsTable>;
export type ExceptionRow = Selectable<AttendanceExceptionsTable>;
export type NewException = Insertable<AttendanceExceptionsTable>;

/** What ATT-03 asks for: a section's session, or every section of an Institution's, on one date. */
export interface SessionFilter {
  date: string;
  sectionId?: string;
  institutionId?: string;
}

/** Queries on `attendance_sessions` and `attendance_exceptions`; each runs in the caller's transaction, under row-level security. */
@Injectable()
export class AttendanceRepository {
  /** The active session of the section on the date, if one was submitted. */
  findActive(tx: Tx, sectionId: string, date: string): Promise<SessionRow | undefined> {
    return tx
      .selectFrom('attendance_sessions')
      .selectAll()
      .where('section_id', '=', sectionId)
      .where('attendance_date', '=', date)
      .where('status', '=', 1)
      .executeTakeFirst();
  }

  /**
   * Holds the section's register until the transaction ends. A submit (ATT-02) and a move out of the section (STU-08)
   * both take it before they read, so the one that comes second sees what the first wrote: the submit then counts the
   * roster without the student, or the move sees the register taken (QA B6 D1, two requests at once).
   */
  async lockRegister(tx: Tx, sectionId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`attendance-register:${sectionId}`}, 0))`.execute(
      tx,
    );
  }

  /**
   * The latest day on or after `from` on which the section's attendance was taken (an active session) after `placedAt`,
   * the time a student was placed in the section: the student was on that session's roster (DDD 13.2). The stored time
   * keeps microseconds and `placedAt` milliseconds, so the stored time is cut to milliseconds as the roster does.
   */
  async latestTakenDay(
    tx: Tx,
    sectionId: string,
    from: string,
    placedAt: Date,
  ): Promise<string | undefined> {
    const row = await tx
      .selectFrom('attendance_sessions')
      .select((eb) => eb.fn.max('attendance_date').as('day'))
      .where('section_id', '=', sectionId)
      .where('status', '=', 1)
      .where('attendance_date', '>=', from)
      .where(sql`date_trunc('milliseconds', submitted_at)`, '>=', placedAt)
      .executeTakeFirst();
    return row?.day ?? undefined;
  }

  find(tx: Tx, id: string): Promise<SessionRow | undefined> {
    return tx
      .selectFrom('attendance_sessions')
      .selectAll()
      .where('id', '=', id)
      .where('status', '=', 1)
      .executeTakeFirst();
  }

  /** The active sessions of the filter, by section. */
  list(tx: Tx, filter: SessionFilter): Promise<SessionRow[]> {
    return tx
      .selectFrom('attendance_sessions')
      .selectAll()
      .where('attendance_date', '=', filter.date)
      .where('status', '=', 1)
      .$if(filter.sectionId !== undefined, (query) =>
        query.where('section_id', '=', filter.sectionId!),
      )
      .$if(filter.institutionId !== undefined, (query) =>
        query.where('institution_id', '=', filter.institutionId!),
      )
      .orderBy('submitted_at')
      .orderBy('id')
      .execute();
  }

  insert(tx: Tx, values: NewSession): Promise<SessionRow> {
    return tx
      .insertInto('attendance_sessions')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async insertExceptions(tx: Tx, rows: readonly NewException[]): Promise<void> {
    if (rows.length === 0) return;
    await tx
      .insertInto('attendance_exceptions')
      .values([...rows])
      .execute();
  }

  /** The marks of a session, by the order they were sent in (the enrolment ID breaks ties). */
  exceptionsOf(tx: Tx, sessionId: string, date: string): Promise<ExceptionRow[]> {
    return tx
      .selectFrom('attendance_exceptions')
      .selectAll()
      .where('attendance_session_id', '=', sessionId)
      .where('attendance_date', '=', date)
      .orderBy('attendance_status')
      .orderBy('student_enrolment_id')
      .execute();
  }
}
