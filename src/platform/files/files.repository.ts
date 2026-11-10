import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../database/index.js';
import type { FilesTable } from './files.tables.js';

export type FileRow = Selectable<FilesTable>;
export type NewFile = Insertable<FilesTable>;
export type FileChanges = Updateable<FilesTable>;

/** Queries on `files`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class FilesRepository {
  find(tx: Tx, id: string): Promise<FileRow | undefined> {
    return tx.selectFrom('files').selectAll().where('id', '=', id).executeTakeFirst();
  }

  findMany(tx: Tx, ids: readonly string[]): Promise<FileRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return tx.selectFrom('files').selectAll().where('id', 'in', ids).execute();
  }

  insert(tx: Tx, values: NewFile): Promise<FileRow> {
    return tx.insertInto('files').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /** Changes a file that is still Pending; undefined when someone else already settled it. */
  settlePending(tx: Tx, id: string, changes: FileChanges): Promise<FileRow | undefined> {
    return tx
      .updateTable('files')
      .set(changes)
      .where('id', '=', id)
      .where('file_status', '=', 1)
      .returningAll()
      .executeTakeFirst();
  }
}
