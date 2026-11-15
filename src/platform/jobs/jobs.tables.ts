import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely type of `jobs`: a unit of background work for the worker (SDD 11.2). The app role only inserts a job; the
 * worker claims and settles it through the `maintenance` functions, never by reading the table.
 */
export interface JobsTable {
  id: string;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, never>;
  society_id: string;
  /** Empty for work that belongs to the whole Society. */
  institution_id: string | null;
  /** Names the handler. */
  kind: string;
  /** What the handler needs; never personal data. */
  payload: ColumnType<unknown, string, never>;
  /** 1 queued, 2 running, 3 done, 4 failed. */
  job_status: Generated<number>;
  run_at: ColumnType<Date, Date | undefined, never>;
  attempts: Generated<number>;
  locked_until: Date | null;
  finished_at: Date | null;
  last_error: string | null;
}
