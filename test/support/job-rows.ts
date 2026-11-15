import { sql, type Kysely } from 'kysely';

export interface JobRow {
  id: string;
  kind: string;
  society_id: string;
  institution_id: string | null;
  created_by: string | null;
  payload: Record<string, unknown>;
  job_status: number;
  run_at: Date;
  attempts: number;
  locked_until: Date | null;
  finished_at: Date | null;
  last_error: string | null;
}

/**
 * The jobs of a Society, oldest first, optionally of one kind. The jobs are closed to the app role, so a test reads
 * them as the table owner (`db`), who is not bound by their row-level security.
 */
export async function readJobs(
  db: Kysely<unknown>,
  societyId: string,
  kind?: string,
): Promise<JobRow[]> {
  const { rows } = await sql<JobRow>`
    select * from jobs where society_id = ${societyId} and (${kind ?? null}::text is null or kind = ${kind ?? null})
    order by created_at, id`.execute(db);
  return rows;
}

/** Changes the jobs of a Society, for a test that needs a lease that has run out or a pause that is over. */
export async function changeJobs(
  db: Kysely<unknown>,
  societyId: string,
  changes: ReturnType<typeof sql>,
): Promise<void> {
  await sql`update jobs set ${changes} where society_id = ${societyId}`.execute(db);
}
