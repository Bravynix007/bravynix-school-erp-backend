import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { Database, Tx } from '../../src/platform/database/index.js';

export interface LoggedQuery {
  sql: string;
  parameters: readonly unknown[];
}

/**
 * A Kysely that runs nothing and records the SQL it was asked to run, for unit
 * tests of a repository. It answers each query with the next of `answers` (the
 * rows of that query) and with no rows once they are used up, so a call that
 * needs a row ends in an error after its SQL was recorded.
 */
export function sqlRecorder(answers: readonly (readonly object[])[] = []) {
  let answered = 0;
  const connection: DatabaseConnection = {
    executeQuery: <R>(): Promise<QueryResult<R>> =>
      Promise.resolve({ rows: [...(answers[answered++] ?? [])] as R[] }),
    streamQuery: () => {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const queries: LoggedQuery[] = [];
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') {
        queries.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });
  return { tx: db as unknown as Tx, queries };
}
