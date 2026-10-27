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
import { BlockSection } from '../../common/auth/block-section.js';
import { institutionHasBlock } from './block-columns.js';
import type { InstitutionsTable } from './tenancy.tables.js';

export type InstitutionRow = Selectable<InstitutionsTable> & { society_name: string };

/** A row of the PLT-19 list: which sections of the Institution are blocked. */
export type InstitutionListRow = InstitutionRow & {
  staff_blocked: boolean;
  students_blocked: boolean;
};

export type NewInstitution = Insertable<InstitutionsTable>;
export type InstitutionChanges = Updateable<InstitutionsTable>;

export interface InstitutionFilter {
  q?: string;
  societyId?: string;
  statuses?: readonly number[];
  /** Any of its sections blocked, or none. */
  blocked?: boolean;
}

export type InstitutionSortField = 'name' | 'code' | 'createdAt';

const SORT_COLUMN = {
  name: sql`lower(institutions.name)`,
  code: sql`lower(institutions.code)`,
  createdAt: sql`institutions.created_at`,
} as const;

/** Queries on `institutions`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class InstitutionRepository {
  private selectInstitution(tx: Tx) {
    return tx
      .selectFrom('institutions')
      .innerJoin('societies', 'societies.id', 'institutions.society_id')
      .selectAll('institutions')
      .select('societies.name as society_name');
  }

  private matching(filter: InstitutionFilter) {
    return (eb: ExpressionBuilder<Database, 'institutions'>) => {
      const conditions = [];
      if (filter.q) {
        const pattern = containsPattern(filter.q);
        conditions.push(
          eb.or([
            eb('institutions.name', 'ilike', pattern),
            eb('institutions.code', 'ilike', pattern),
          ]),
        );
      }
      if (filter.societyId) conditions.push(eb('institutions.society_id', '=', filter.societyId));
      if (filter.statuses?.length)
        conditions.push(eb('institutions.status', 'in', filter.statuses));
      if (filter.blocked !== undefined) {
        const any = sql<boolean>`(${institutionHasBlock(BlockSection.Staff)} or ${institutionHasBlock(BlockSection.Students)})`;
        conditions.push(filter.blocked ? any : sql<boolean>`not ${any}`);
      }
      return eb.and(conditions);
    };
  }

  async page(
    tx: Tx,
    filter: InstitutionFilter,
    sort: readonly SortKey<InstitutionSortField>[],
    limit: number,
    offset: number,
  ): Promise<{ rows: InstitutionListRow[]; total: number }> {
    let query = this.selectInstitution(tx)
      .select([
        institutionHasBlock(BlockSection.Staff).as('staff_blocked'),
        institutionHasBlock(BlockSection.Students).as('students_blocked'),
      ])
      .where(this.matching(filter));
    for (const key of sort) query = query.orderBy(SORT_COLUMN[key.field], key.direction);
    const rows = await query.orderBy('institutions.id').limit(limit).offset(offset).execute();
    const { total } = await tx
      .selectFrom('institutions')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where(this.matching(filter))
      .executeTakeFirstOrThrow();
    return { rows, total };
  }

  /** The active Institutions among `ids`, by name: what an Owner's or Admin's switcher shows. */
  async activeAmong(tx: Tx, societyId: string, ids: readonly string[]): Promise<InstitutionRow[]> {
    if (ids.length === 0) return [];
    return this.selectInstitution(tx)
      .where('institutions.society_id', '=', societyId)
      .where('institutions.status', '=', 1)
      .where('institutions.id', 'in', ids)
      .orderBy(sql`lower(institutions.name)`)
      .orderBy('institutions.id')
      .execute();
  }

  /** `undefined` when there is no such Institution. `lock` holds the row until the transaction ends. */
  async find(tx: Tx, id: string, lock = false): Promise<InstitutionRow | undefined> {
    let query = this.selectInstitution(tx).where('institutions.id', '=', id);
    if (lock) query = query.forUpdate('institutions');
    return query.executeTakeFirst();
  }

  async insert(tx: Tx, values: NewInstitution): Promise<void> {
    await tx.insertInto('institutions').values(values).execute();
  }

  async update(tx: Tx, id: string, changes: InstitutionChanges): Promise<void> {
    await tx.updateTable('institutions').set(changes).where('id', '=', id).execute();
  }
}
