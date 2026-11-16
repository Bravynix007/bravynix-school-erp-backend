import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/index.js';

/** A file that is due to go: its object is removed, then its row is settled. */
export interface DueFile {
  id: string;
  objectKey: string;
  /** The status the row was listed in; the row is marked only while it is still in it. */
  status: number;
}

/**
 * The clean-up the worker does across every Society, through the `maintenance` functions, outside any tenant: the
 * tables they touch are closed to the app role.
 */
@Injectable()
export class SweepsRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Gives the Ready files that should go their `delete_after`; says how many. */
  async expireFiles(documentDays: number, graceHours: number): Promise<number> {
    const { rows } = await sql<{ expired: number }>`
      select maintenance.expire_files(${documentDays}::integer, ${graceHours}::integer) as expired
    `.execute(this.database.db);
    return rows[0]!.expired;
  }

  /** Up to `limit` files whose `delete_after` has passed. */
  async dueFiles(limit: number): Promise<DueFile[]> {
    const { rows } = await sql<{ id: string; object_key: string; file_status: number }>`
      select * from maintenance.expired_files(${limit}::integer)
    `.execute(this.database.db);
    return rows.map((row) => ({ id: row.id, objectKey: row.object_key, status: row.file_status }));
  }

  /** Marks the file Deleted; false when it is no longer in the status it was listed in. */
  async markDeleted(file: DueFile): Promise<boolean> {
    const { rows } = await sql<{ settled: boolean }>`
      select maintenance.settle_file_deleted(${file.id}::uuid, ${file.status}::smallint) as settled
    `.execute(this.database.db);
    return rows[0]!.settled;
  }

  /** Deletes the import runs that finished `days` ago; says how many. */
  async removeImportRuns(days: number): Promise<number> {
    const { rows } = await sql<{ removed: number }>`
      select maintenance.remove_import_runs(${days}::integer) as removed
    `.execute(this.database.db);
    return rows[0]!.removed;
  }
}
