import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { AttendanceExceptionsTable, AttendanceSessionsTable } from './attendance.tables.js';

export type SessionRow = Selectable<AttendanceSessionsTable>;
export type NewSession = Insertable<AttendanceSessionsTable>;
export type ExceptionRow = Selectable<AttendanceExceptionsTable>;
export type NewException = Insertable<AttendanceExceptionsTable>;
export type SessionChanges = Updateable<AttendanceSessionsTable>;

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

  /** The session whatever its status, so a voided one can be told from one that is not there. */
  findAny(tx: Tx, id: string): Promise<SessionRow | undefined> {
    return tx.selectFrom('attendance_sessions').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** The session whatever its status, held until the transaction ends so two corrections take turns. */
  lockAny(tx: Tx, id: string): Promise<SessionRow | undefined> {
    return tx
      .selectFrom('attendance_sessions')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  update(tx: Tx, id: string, changes: SessionChanges): Promise<SessionRow> {
    return tx
      .updateTable('attendance_sessions')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
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

  /** Changes the mark of one student in a session. */
  async setStatus(
    tx: Tx,
    sessionId: string,
    date: string,
    enrolmentId: string,
    status: number,
    correction: { at: Date; by: string },
  ): Promise<void> {
    await tx
      .updateTable('attendance_exceptions')
      .set({ attendance_status: status, corrected_at: correction.at, corrected_by: correction.by })
      .where('attendance_session_id', '=', sessionId)
      .where('attendance_date', '=', date)
      .where('student_enrolment_id', '=', enrolmentId)
      .execute();
  }

  /** Takes students back to Present: their exceptions go. */
  async removeExceptions(
    tx: Tx,
    sessionId: string,
    date: string,
    enrolmentIds: readonly string[],
  ): Promise<void> {
    if (enrolmentIds.length === 0) return;
    await tx
      .deleteFrom('attendance_exceptions')
      .where('attendance_session_id', '=', sessionId)
      .where('attendance_date', '=', date)
      .where('student_enrolment_id', 'in', [...enrolmentIds])
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
