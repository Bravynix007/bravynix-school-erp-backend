import { Injectable } from '@nestjs/common';
import { sql, type Insertable, type Selectable, type Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { AcademicYearsTable } from './academic-setup.tables.js';

export type AcademicYearRow = Selectable<AcademicYearsTable>;
export type NewAcademicYear = Insertable<AcademicYearsTable>;
export type AcademicYearChanges = Updateable<AcademicYearsTable>;

/** Queries on `academic_years`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class AcademicYearRepository {
  /**
   * Serializes the writes to one Institution's years for the rest of the transaction, so two requests cannot
   * both make the first year current, or swap the current year at once. Taken before any row is read for update.
   */
  async lockInstitution(tx: Tx, institutionId: string): Promise<void> {
    await sql`
      select pg_advisory_xact_lock(hashtextextended(${`academic_years:${institutionId}`}, 0))
    `.execute(tx);
  }

  /** The active years, the one that starts latest first. */
  active(tx: Tx, institutionId: string): Promise<AcademicYearRow[]> {
    return tx
      .selectFrom('academic_years')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('status', '=', 1)
      .orderBy('start_date', 'desc')
      .execute();
  }

  async find(tx: Tx, id: string, lock = false): Promise<AcademicYearRow | undefined> {
    const query = tx.selectFrom('academic_years').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  async hasActive(tx: Tx, institutionId: string): Promise<boolean> {
    const row = await tx
      .selectFrom('academic_years')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where('status', '=', 1)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The active year that is current, if any. */
  currentOf(tx: Tx, institutionId: string): Promise<AcademicYearRow | undefined> {
    return tx
      .selectFrom('academic_years')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('status', '=', 1)
      .where('is_current', '=', true)
      .executeTakeFirst();
  }

  insert(tx: Tx, values: NewAcademicYear): Promise<AcademicYearRow> {
    return tx.insertInto('academic_years').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: AcademicYearChanges): Promise<AcademicYearRow> {
    return tx
      .updateTable('academic_years')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
