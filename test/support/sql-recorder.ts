import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { Database, Tx } from '../../src/platform/database/index.js';

export interface LoggedQuery {
  sql: string;
  parameters: readonly unknown[];
}

/**
 * A Kysely that runs nothing and records the SQL it was asked to run, for unit
 * tests of a repository. The dummy driver returns no rows, so a call that needs
 * one ends in an error after its SQL was recorded.
 */
export function sqlRecorder() {
  const queries: LoggedQuery[] = [];
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
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
