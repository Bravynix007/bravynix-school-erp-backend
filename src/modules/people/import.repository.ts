import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { ImportRunsTable } from './people.tables.js';
import { RunStatus, type RowError } from './import.rules.js';

export type ImportRunRow = Selectable<ImportRunsTable>;
export type NewImportRun = Insertable<ImportRunsTable>;

/** The run's progress as the worker last settled it. */
export interface ImportProgress {
  processedRows: number;
  importedRows: number;
  skippedRows: number;
  rowErrors: readonly RowError[];
  overCapacity: boolean;
}

/** Queries on `import_runs`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class ImportRepository {
  find(tx: Tx, id: string): Promise<ImportRunRow | undefined> {
    return tx.selectFrom('import_runs').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** The run, held until the transaction ends: a worker that lost its lease cannot settle a batch behind another's. */
  findForUpdate(tx: Tx, id: string): Promise<ImportRunRow | undefined> {
    return tx
      .selectFrom('import_runs')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** The runs of an Institution, newest first, with how many there are. */
  async listOf(
    tx: Tx,
    institutionId: string,
    page: { limit: number; offset: number },
  ): Promise<{ rows: ImportRunRow[]; total: number }> {
    const { total } = await tx
      .selectFrom('import_runs')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('institution_id', '=', institutionId)
      .executeTakeFirstOrThrow();
    const rows = await tx
      .selectFrom('import_runs')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    return { rows, total: Number(total) };
  }

  insert(tx: Tx, values: NewImportRun): Promise<ImportRunRow> {
    return tx.insertInto('import_runs').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /** The worker has picked the run up and counted its rows. */
  async start(tx: Tx, id: string, totalRows: number, at: Date): Promise<void> {
    await tx
      .updateTable('import_runs')
      .set({ run_status: RunStatus.Running, total_rows: totalRows, started_at: at })
      .where('id', '=', id)
      .where('run_status', 'in', [RunStatus.Queued, RunStatus.Running])
      .execute();
  }

  /** Writes the progress of a batch; `finished` completes the run. */
  async settle(
    tx: Tx,
    id: string,
    progress: ImportProgress,
    finishedAt: Date | null,
  ): Promise<void> {
    await tx
      .updateTable('import_runs')
      .set({
        processed_rows: progress.processedRows,
        imported_rows: progress.importedRows,
        skipped_rows: progress.skippedRows,
        row_errors: JSON.stringify(progress.rowErrors),
        over_capacity: progress.overCapacity,
        ...(finishedAt === null
          ? {}
          : { run_status: RunStatus.Completed, finished_at: finishedAt }),
      })
      .where('id', '=', id)
      .execute();
  }

  /** Fails the run: no row was read (a bad header, too many rows), or the worker gave up. */
  async fail(
    tx: Tx,
    id: string,
    failure: { code: string; totalRows?: number },
    at: Date,
  ): Promise<void> {
    await tx
      .updateTable('import_runs')
      .set({
        run_status: RunStatus.Failed,
        error_code: failure.code,
        finished_at: at,
        ...(failure.totalRows === undefined ? {} : { total_rows: failure.totalRows }),
      })
      .where('id', '=', id)
      .where('run_status', 'in', [RunStatus.Queued, RunStatus.Running])
      .execute();
  }
}
