import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { AppConfig } from '../../config/app-config.js';
import type { Database } from './schema.js';

/**
 * The tenant settings every transaction carries. Row-level security policies
 * read them through `app_current_*()` SQL functions (DDD 15.3), so a query
 * that forgets a WHERE clause still cannot see another tenant's rows.
 */
export interface TenantContext {
  personId?: string | null;
  societyId?: string | null;
  /** Institutions in the caller's scope. */
  institutionIds?: readonly string[];
  roleCode?: number | null;
  viaSupportAccess?: boolean;
}

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

/** Postgres error codes the API translates to business errors. */
export const PgErrorCode = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  exclusionViolation: '23P01',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

export function createPool(
  connectionString: string,
  max: number,
  statementTimeoutMs: number,
): pg.Pool {
  // Postgres `date` columns are school days: keep them as YYYY-MM-DD strings,
  // never shift them through a JS Date and the server's time zone.
  pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
  // numeric is money and marks: keep exact decimal strings.
  pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value);
  // bigint counts fit in a JS number for this system's volumes.
  pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
  return new pg.Pool({
    connectionString,
    max,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: statementTimeoutMs * 2,
    application_name: 'bravynix-school-erp-api',
  });
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly db: Db;

  constructor(config: AppConfig) {
    const { env } = config;
    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: createPool(
          env.DATABASE_URL,
          env.DATABASE_POOL_MAX,
          env.DATABASE_STATEMENT_TIMEOUT_MS,
        ),
      }),
    });
  }

  /**
   * Runs `work` in one transaction with the tenant settings applied. Every
   * write path uses this: business change, audit entry and jobs commit or
   * roll back together (SDD 9.3 rule 4).
   */
  async transaction<T>(tenant: TenantContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await applyTenant(tx, tenant);
      return work(tx);
    });
  }

  async ping(): Promise<boolean> {
    try {
      await sql`select 1`.execute(this.db);
      return true;
    } catch (error) {
      this.logger.warn({ err: error }, 'Database ping failed');
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}

export async function applyTenant(tx: Tx, tenant: TenantContext): Promise<void> {
  // set_config(..., true) scopes each value to this transaction only, so a
  // pooled connection never carries one request's tenant into the next.
  await sql`
    select
      set_config('app.person_id', ${tenant.personId ?? ''}, true),
      set_config('app.society_id', ${tenant.societyId ?? ''}, true),
      set_config('app.institution_ids', ${(tenant.institutionIds ?? []).join(',')}, true),
      set_config('app.role_code', ${tenant.roleCode?.toString() ?? ''}, true),
      set_config('app.via_support', ${tenant.viaSupportAccess ? 'true' : 'false'}, true)
  `.execute(tx);
}
