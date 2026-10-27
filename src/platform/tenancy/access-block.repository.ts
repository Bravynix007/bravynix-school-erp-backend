import { Injectable } from '@nestjs/common';
import { sql, type ExpressionBuilder, type Insertable, type Selectable } from 'kysely';
import { containsPattern, type SortKey } from '../../common/pagination/pagination.js';
import type { Database, Tx } from '../database/index.js';
import type { AccessBlocksTable } from './tenancy.tables.js';

export type AccessBlockRow = Selectable<AccessBlocksTable>;
export type NewAccessBlock = Insertable<AccessBlocksTable>;

/** An active block of the caller's Society, with the Institution's name (SOC-02). */
export type SocietyBlockRow = AccessBlockRow & { institution_name: string | null };

export interface AccessBlockFilter {
  q?: string;
  societyId?: string;
  institutionId?: string;
  sections?: readonly number[];
}

export type AccessBlockSortField = 'blockedAt';

/** Queries on `access_blocks`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class AccessBlockRepository {
  async insert(tx: Tx, values: NewAccessBlock): Promise<AccessBlockRow> {
    return tx.insertInto('access_blocks').values(values).returningAll().executeTakeFirstOrThrow();
  }

  async find(tx: Tx, id: string): Promise<AccessBlockRow | undefined> {
    return tx.selectFrom('access_blocks').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * Lifts the block with one conditional write, so two lifts that race give one
   * row and one `undefined`; the second finds nothing left to lift.
   */
  async lift(tx: Tx, id: string, by: string, at: Date): Promise<AccessBlockRow | undefined> {
    return tx
      .updateTable('access_blocks')
      .set({ lifted_at: at, lifted_by: by, updated_by: by })
      .where('id', '=', id)
      .where('lifted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /** Active blocks only, newest first unless `sort` says otherwise. */
  async page(
    tx: Tx,
    filter: AccessBlockFilter,
    sort: readonly SortKey<AccessBlockSortField>[],
    limit: number,
    offset: number,
  ): Promise<{ rows: AccessBlockRow[]; total: number }> {
    let query = this.active(tx).selectAll().where(this.matching(filter));
    for (const key of sort) query = query.orderBy(sql.ref('created_at'), key.direction);
    const rows = await query.orderBy('id').limit(limit).offset(offset).execute();
    const { total } = await this.active(tx)
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where(this.matching(filter))
      .executeTakeFirstOrThrow();
    return { rows, total };
  }

  /** The Society's active blocks, by when they were set, with the Institution's name. */
  async activeIn(tx: Tx, societyId: string): Promise<SocietyBlockRow[]> {
    return this.active(tx)
      .leftJoin('institutions', 'institutions.id', 'access_blocks.institution_id')
      .selectAll('access_blocks')
      .select('institutions.name as institution_name')
      .where('access_blocks.society_id', '=', societyId)
      .orderBy('access_blocks.created_at')
      .orderBy('access_blocks.id')
      .execute();
  }

  private matching(filter: AccessBlockFilter) {
    return (eb: ExpressionBuilder<Database, 'access_blocks'>) => {
      const conditions = [];
      if (filter.q) conditions.push(eb('reason', 'ilike', containsPattern(filter.q)));
      if (filter.societyId) conditions.push(eb('society_id', '=', filter.societyId));
      if (filter.institutionId) conditions.push(eb('institution_id', '=', filter.institutionId));
      if (filter.sections?.length) conditions.push(eb('section', 'in', filter.sections));
      return eb.and(conditions);
    };
  }

  private active(tx: Tx) {
    return tx.selectFrom('access_blocks').where('access_blocks.lifted_at', 'is', null);
  }
}
