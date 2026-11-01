import { Injectable } from '@nestjs/common';
import type { ExpressionBuilder, Insertable, Selectable } from 'kysely';
import { containsPattern, type SortKey } from '../../common/pagination/pagination.js';
import type { Database, Tx } from '../../platform/database/index.js';
import type { DueSortField } from './due.dto.js';
import type { PlatformDuesTable } from './billing.tables.js';

export type DueRow = Selectable<PlatformDuesTable>;
export type NewDue = Insertable<PlatformDuesTable>;

export interface DueFilter {
  q?: string;
  societyId?: string;
  institutionId?: string;
  statuses?: readonly number[];
}

const SORT_COLUMN = {
  createdAt: 'platform_dues.created_at',
  dueDate: 'platform_dues.due_date',
  invoiceNo: 'platform_dues.invoice_no',
  periodStartDate: 'platform_dues.period_start_date',
  totalAmount: 'platform_dues.total_amount',
} as const satisfies Record<DueSortField, string>;

/** Queries on `platform_dues`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class DueRepository {
  private matching(filter: DueFilter) {
    return (eb: ExpressionBuilder<Database, 'platform_dues'>) => {
      const conditions = [];
      if (filter.q) conditions.push(eb('invoice_no', 'ilike', containsPattern(filter.q)));
      if (filter.societyId) conditions.push(eb('society_id', '=', filter.societyId));
      if (filter.institutionId) conditions.push(eb('institution_id', '=', filter.institutionId));
      if (filter.statuses?.length) conditions.push(eb('due_status', 'in', filter.statuses));
      return eb.and(conditions);
    };
  }

  insert(tx: Tx, values: NewDue): Promise<DueRow> {
    return tx.insertInto('platform_dues').values(values).returningAll().executeTakeFirstOrThrow();
  }

  find(tx: Tx, id: string): Promise<DueRow | undefined> {
    return tx.selectFrom('platform_dues').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async page(
    tx: Tx,
    filter: DueFilter,
    sort: readonly SortKey<DueSortField>[],
    limit: number,
    offset: number,
  ): Promise<{ rows: DueRow[]; total: number }> {
    let query = tx.selectFrom('platform_dues').selectAll().where(this.matching(filter));
    for (const key of sort) query = query.orderBy(SORT_COLUMN[key.field], key.direction);
    const rows = await query.orderBy('platform_dues.id').limit(limit).offset(offset).execute();
    const { total } = await tx
      .selectFrom('platform_dues')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where(this.matching(filter))
      .executeTakeFirstOrThrow();
    return { rows, total };
  }
}
