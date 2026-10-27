import { assertSeedable } from './seed-guard.js';

/** The only database `demo:reset` may drop and rebuild. */
export const DEMO_DATABASE = 'school_erp_demo';
const DEFAULT_ADMIN_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

export interface DemoResetTargets {
  /** The migration user's URL for the demo database. */
  migrationUrl: string;
  /** The database administrator's URL, on the maintenance database. */
  adminUrl: string;
}

/** Swaps the database name in a connection URL. */
export function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

/**
 * Decides what `demo:reset` may touch, before it connects anywhere: the migration URL must name the demo database
 * (so a shell variable pointing at a real database stops it), and both URLs must be local and not staging or
 * production. The administrator's URL may name any database: only its server is used, and the database it drops is
 * always `school_erp_demo`.
 */
export function demoResetTargets(env: NodeJS.ProcessEnv): DemoResetTargets {
  const migrationUrl = env.DATABASE_MIGRATION_URL;
  if (!migrationUrl) throw new Error('Set DATABASE_MIGRATION_URL (demo.env does)');
  const named = new URL(migrationUrl).pathname.slice(1);
  if (named !== DEMO_DATABASE) {
    throw new Error(`demo:reset only rebuilds ${DEMO_DATABASE}, not ${named}`);
  }
  assertSeedable(migrationUrl, env.NODE_ENV);
  const adminUrl = env.DEMO_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  assertSeedable(adminUrl, env.NODE_ENV);
  return { migrationUrl, adminUrl: withDatabase(adminUrl, 'postgres') };
}
