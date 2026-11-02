import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../database/index.js';
import type { MasterSpec, MasterTable } from './master.catalog.js';
import type { MasterRow } from './master.resource.js';

/**
 * Queries on the seven master tables, driven by the catalogue. Every table and column name comes from
 * the fixed catalogue (never from a request), so the statements are built with `sql.table` and
 * `sql.ref`, and every value is a parameter.
 */
@Injectable()
export class MasterRepository {
  /** The entries, in the master's order: `display_order` for the lists, name for the places. */
  async list(
    tx: Tx,
    spec: MasterSpec,
    options: { includeHidden: boolean; filters: readonly { column: string; value: string }[] },
  ): Promise<MasterRow[]> {
    const conditions = [
      ...(options.includeHidden ? [] : [sql`status = 1`]),
      ...options.filters.map(({ column, value }) => sql`${sql.ref(column)} = ${value}`),
    ];
    const where = conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;
    const order = spec.ordered ? sql`display_order, id` : sql`lower(name), id`;
    const result = await sql<MasterRow>`
      select * from ${sql.table(spec.table)} ${where} order by ${order}
    `.execute(tx);
    return result.rows;
  }

  async find(tx: Tx, spec: MasterSpec, id: string, lock = false): Promise<MasterRow | undefined> {
    const result = await sql<MasterRow>`
      select * from ${sql.table(spec.table)} where id = ${id} ${lock ? sql`for update` : sql``}
    `.execute(tx);
    return result.rows[0];
  }

  async insert(tx: Tx, spec: MasterSpec, values: Record<string, unknown>): Promise<MasterRow> {
    const columns = Object.keys(values);
    const result = await sql<MasterRow>`
      insert into ${sql.table(spec.table)} (${sql.join(columns.map((column) => sql.ref(column)))})
      values (${sql.join(columns.map((column) => sql.val(values[column])))})
      returning *
    `.execute(tx);
    return result.rows[0]!;
  }

  async update(
    tx: Tx,
    spec: MasterSpec,
    id: string,
    changes: Record<string, unknown>,
  ): Promise<MasterRow> {
    const assignments = Object.entries(changes).map(
      ([column, value]) => sql`${sql.ref(column)} = ${sql.val(value)}`,
    );
    const result = await sql<MasterRow>`
      update ${sql.table(spec.table)} set ${sql.join(assignments)} where id = ${id} returning *
    `.execute(tx);
    return result.rows[0]!;
  }

  /** The status of the entry a new one will belong to; `undefined` when there is none. */
  async statusOf(tx: Tx, table: MasterTable, id: string): Promise<number | undefined> {
    const result = await sql<{ status: number }>`
      select status from ${sql.table(table)} where id = ${id}
    `.execute(tx);
    return result.rows[0]?.status;
  }

  /** The number of entries, hidden ones included: the last position of the list. */
  async count(tx: Tx, spec: MasterSpec): Promise<number> {
    const result = await sql<{ count: number }>`
      select count(*)::int as count from ${sql.table(spec.table)}
    `.execute(tx);
    return result.rows[0]!.count;
  }

  /**
   * Stops other writers of an ordered list while positions shift, so two moves cannot interleave.
   * Taken before any row lock, always, so two writers cannot wait on each other. Readers are not held.
   */
  async lockList(tx: Tx, spec: MasterSpec): Promise<void> {
    await sql`lock table ${sql.table(spec.table)} in share row exclusive mode`.execute(tx);
    if (spec.orderConstraint) {
      await sql`set constraints ${sql.id(spec.orderConstraint)} deferred`.execute(tx);
    }
  }

  /** Moves every entry from `from` to `to` (both included) by one position, `1` down the list or `-1` up it. */
  async shift(
    tx: Tx,
    spec: MasterSpec,
    range: { from: number; to: number },
    by: 1 | -1,
    updatedBy: string | null,
  ): Promise<void> {
    await sql`
      update ${sql.table(spec.table)}
      set display_order = display_order + ${by}, updated_by = ${updatedBy}
      where display_order between ${range.from} and ${range.to}
    `.execute(tx);
  }
}
