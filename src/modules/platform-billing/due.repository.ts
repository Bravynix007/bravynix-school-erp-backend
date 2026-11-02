import { Injectable } from '@nestjs/common';
import {
  sql,
  type ExpressionBuilder,
  type Insertable,
  type Selectable,
  type SelectQueryBuilder,
  type Updateable,
} from 'kysely';
import { containsPattern, type SortKey } from '../../common/pagination/pagination.js';
import type { Database, Tx } from '../../platform/database/index.js';
import type { DueSortField } from './due.dto.js';
import { DueStatus } from './due.rules.js';
import type { PlatformDuesTable } from './billing.tables.js';

export type DueRow = Selectable<PlatformDuesTable>;
export type NewDue = Insertable<PlatformDuesTable>;
export type DueChanges = Updateable<PlatformDuesTable>;

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

  /** One due; `lock` holds the row until the transaction ends, for a change that names the `version` it read. */
  find(tx: Tx, id: string, lock = false): Promise<DueRow | undefined> {
    let query = tx.selectFrom('platform_dues').selectAll().where('id', '=', id);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** Every due the transaction's tenant can read, newest first. An Owner's tenant reads their own Society's only. */
  all(tx: Tx): Promise<DueRow[]> {
    return tx
      .selectFrom('platform_dues')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  /** What each of these Societies still owes: the total of its dues that are Due. A Society that owes nothing is left out. */
  async outstandingBySociety(tx: Tx, societyIds: readonly string[]): Promise<Map<string, string>> {
    if (societyIds.length === 0) return new Map();
    const rows = await tx
      .selectFrom('platform_dues')
      .select(['society_id', sql<string>`sum(total_amount)::numeric(14,2)::text`.as('total')])
      .where('society_id', 'in', societyIds)
      .where('due_status', '=', DueStatus.Due)
      .groupBy('society_id')
      .execute();
    return new Map(rows.map((row) => [row.society_id, row.total]));
  }

  /** The total of every due still Due, across Societies. */
  async outstandingTotal(tx: Tx): Promise<string> {
    return this.sum(tx, (query) => query.where('due_status', '=', DueStatus.Due));
  }

  /** The total of the dues paid on a date from `from` up to but not including `before` (both `YYYY-MM-DD`). */
  async collectedBetween(tx: Tx, from: string, before: string): Promise<string> {
    return this.sum(tx, (query) =>
      query
        .where('due_status', '=', DueStatus.Paid)
        .where('paid_date', '>=', from)
        .where('paid_date', '<', before),
    );
  }

  private async sum(
    tx: Tx,
    narrow: (
      query: SelectQueryBuilder<Database, 'platform_dues', object>,
    ) => SelectQueryBuilder<Database, 'platform_dues', object>,
  ): Promise<string> {
    const { total } = await narrow(tx.selectFrom('platform_dues'))
      .select(sql<string>`coalesce(sum(total_amount), 0)::numeric(14,2)::text`.as('total'))
      .executeTakeFirstOrThrow();
    return total;
  }

  async update(tx: Tx, id: string, changes: DueChanges): Promise<void> {
    await tx.updateTable('platform_dues').set(changes).where('id', '=', id).execute();
  }

  async page(
    tx: Tx,
    filter: DueFilter,
    sort: readonly SortKey<DueSortField>[],
    limit: number,
    offset: number,
  ): Promise<{ rows: DueRow[]; total: number }> {
    let query = tx.selectFrom('platform_dues').selectAll().where(this.matching(filter));
    // A due with no due date (the only nullable sort column) comes last in either direction.
    for (const key of sort) {
      query = query.orderBy(SORT_COLUMN[key.field], (order) =>
        (key.direction === 'asc' ? order.asc() : order.desc()).nullsLast(),
      );
    }
    const rows = await query.orderBy('platform_dues.id').limit(limit).offset(offset).execute();
    const { total } = await tx
      .selectFrom('platform_dues')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where(this.matching(filter))
      .executeTakeFirstOrThrow();
    return { rows, total };
  }
}
