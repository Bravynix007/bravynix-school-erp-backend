import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService, type Tx } from '../database/index.js';
import type { ClaimedJob } from './job-handler.js';

interface ClaimedRow {
  id: string;
  kind: string;
  society_id: string;
  institution_id: string | null;
  created_by: string | null;
  payload: unknown;
  attempts: number;
}

/** A job to queue. */
export interface NewJob {
  id: string;
  kind: string;
  societyId: string;
  institutionId: string | null;
  createdBy: string | null;
  payload: object;
}

/**
 * Queries on `jobs`. A job is queued in the caller's transaction, under row-level security; the worker claims and
 * settles through the `maintenance` functions, outside any tenant, because the table is closed to the app role.
 */
@Injectable()
export class JobsRepository {
  constructor(private readonly database: DatabaseService) {}

  async insert(tx: Tx, job: NewJob): Promise<void> {
    await tx
      .insertInto('jobs')
      .values({
        id: job.id,
        kind: job.kind,
        society_id: job.societyId,
        institution_id: job.institutionId,
        created_by: job.createdBy,
        payload: JSON.stringify(job.payload),
      })
      .execute();
  }

  /** Takes the oldest job that is due, or one whose worker stopped; `undefined` when there is none. */
  async claim(leaseSeconds: number): Promise<ClaimedJob | undefined> {
    const { rows } = await sql<ClaimedRow>`
      select * from maintenance.claim_job(${leaseSeconds}::integer)
    `.execute(this.database.db);
    const row = rows[0];
    return (
      row && {
        id: row.id,
        kind: row.kind,
        societyId: row.society_id,
        institutionId: row.institution_id,
        startedBy: row.created_by,
        payload: row.payload,
        attempts: row.attempts,
      }
    );
  }

  /** Renews the lease; false when the job is no longer this worker's. */
  async extend(id: string, leaseSeconds: number): Promise<boolean> {
    const { rows } = await sql<{ held: boolean }>`
      select maintenance.extend_job(${id}::uuid, ${leaseSeconds}::integer) as held
    `.execute(this.database.db);
    return rows[0]!.held;
  }

  async settle(id: string, done: boolean, error: string | null): Promise<void> {
    await sql`
      select maintenance.settle_job(${id}::uuid, ${done ? 3 : 4}::smallint, ${error}::text)
    `.execute(this.database.db);
  }

  async retry(id: string, delaySeconds: number, error: string): Promise<void> {
    await sql`
      select maintenance.retry_job(${id}::uuid, ${delaySeconds}::integer, ${error}::text)
    `.execute(this.database.db);
  }
}
