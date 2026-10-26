import { Injectable } from '@nestjs/common';
import {
  sql,
  type ExpressionBuilder,
  type Insertable,
  type Selectable,
  type Updateable,
} from 'kysely';
import { containsPattern, type SortKey } from '../../common/pagination/pagination.js';
import type { Database, Tx } from '../database/index.js';
import type { InstitutionsTable, SocietiesTable } from './tenancy.tables.js';

export type SocietyRow = Selectable<SocietiesTable> & {
  /** Active Institutions, derived. */
  institution_count: number;
};

export type NewSociety = Insertable<SocietiesTable>;

export type SocietyChanges = Updateable<SocietiesTable>;

export interface SocietyFilter {
  q?: string;
  statuses?: readonly number[];
  paused?: boolean;
}

export type SocietySortField = 'name' | 'code' | 'createdAt';

export type SocietyInstitution = Pick<
  Selectable<InstitutionsTable>,
  'id' | 'code' | 'name' | 'status'
> & {
  paused: boolean;
};

const SORT_COLUMN = {
  name: sql`lower(name)`,
  code: sql`lower(code)`,
  createdAt: sql`created_at`,
} as const;

/** Queries on `societies`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class SocietyRepository {
  private selectSociety(tx: Tx) {
    return tx
      .selectFrom('societies')
      .selectAll('societies')
      .select((eb) =>
        eb
          .selectFrom('institutions')
          .select((inner) => inner.fn.countAll<number>().as('count'))
          .whereRef('institutions.society_id', '=', 'societies.id')
          .where('institutions.status', '=', 1)
          .as('institution_count'),
      );
  }

  private matching(filter: SocietyFilter) {
    return (eb: ExpressionBuilder<Database, 'societies'>) => {
      const conditions = [];
      if (filter.q) {
        const pattern = containsPattern(filter.q);
        conditions.push(eb.or([eb('name', 'ilike', pattern), eb('code', 'ilike', pattern)]));
      }
      if (filter.statuses?.length) conditions.push(eb('status', 'in', filter.statuses));
      if (filter.paused !== undefined) {
        conditions.push(eb('access_paused_at', filter.paused ? 'is not' : 'is', null));
      }
      return eb.and(conditions);
    };
  }

  async page(
    tx: Tx,
    filter: SocietyFilter,
    sort: readonly SortKey<SocietySortField>[],
    limit: number,
    offset: number,
  ): Promise<{ rows: SocietyRow[]; total: number }> {
    let query = this.selectSociety(tx).where(this.matching(filter));
    for (const key of sort) query = query.orderBy(SORT_COLUMN[key.field], key.direction);
    const rows = await query.orderBy('id').limit(limit).offset(offset).execute();
    const { total } = await tx
      .selectFrom('societies')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where(this.matching(filter))
      .executeTakeFirstOrThrow();
    return { rows: rows as SocietyRow[], total };
  }

  /** `undefined` when there is no such Society. `lock` holds the row until the transaction ends. */
  async find(tx: Tx, id: string, lock = false): Promise<SocietyRow | undefined> {
    let query = this.selectSociety(tx).where('id', '=', id);
    if (lock) query = query.forUpdate();
    return (await query.executeTakeFirst()) as SocietyRow | undefined;
  }

  /** The code and name of these Societies, by ID. */
  async refs(
    tx: Tx,
    ids: readonly string[],
  ): Promise<Map<string, { id: string; code: string; name: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .selectFrom('societies')
      .select(['id', 'code', 'name'])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((row) => [row.id, row]));
  }

  async insert(tx: Tx, values: NewSociety): Promise<void> {
    await tx.insertInto('societies').values(values).execute();
  }

  async update(tx: Tx, id: string, changes: SocietyChanges): Promise<void> {
    await tx.updateTable('societies').set(changes).where('id', '=', id).execute();
  }

  async institutions(tx: Tx, societyId: string): Promise<SocietyInstitution[]> {
    const rows = await tx
      .selectFrom('institutions')
      .select(['id', 'code', 'name', 'status', 'access_paused_at'])
      .where('society_id', '=', societyId)
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .execute();
    return rows.map(({ access_paused_at: pausedAt, ...row }) => ({
      ...row,
      paused: pausedAt !== null,
    }));
  }
}
