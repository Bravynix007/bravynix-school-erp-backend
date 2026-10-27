import { sql } from 'kysely';
import pg from 'pg';
import {
  beforeCursor,
  cursorMeta,
  cursorTimestamp,
  decodeCursor,
} from '../../src/common/pagination/pagination.js';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import { createPool, DatabaseService } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

describe('migrations', () => {
  it('run down to nothing and back up cleanly', async () => {
    const reset = await runMigrations(migrationUrl, 'reset');
    expect(reset.error).toBeUndefined();
    const up = await runMigrations(migrationUrl, 'latest');
    expect(up.error).toBeUndefined();
    const again = await runMigrations(migrationUrl, 'latest');
    expect(again.error).toBeUndefined();
    expect(again.results).toEqual([]);
  });
});

describe('the connection pool', () => {
  it('logs the loss of an idle connection instead of ending the process, and the next query opens a new one', async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const pool = createPool(url, 1, 5_000);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const first = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
      // The connection is idle in the pool now. Kill it from outside, as a failover or a proxy would.
      const killer = new pg.Client({ connectionString: url });
      await killer.connect();
      await killer.query('select pg_terminate_backend($1)', [first.rows[0]!.pid]);
      await killer.end();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          { err: expect.any(Error) },
          'An idle database connection was lost',
        ),
      );
      const next = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
      expect(next.rows[0]!.pid).not.toBe(first.rows[0]!.pid);
    } finally {
      warn.mockRestore();
      await pool.end();
    }
  });
});

/** Runs DDL as the migrator, which owns the schema (the app user cannot). */
async function asMigrator(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

describe('DatabaseService', () => {
  let t: TestApp;
  let database: DatabaseService;

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    await asMigrator(`
      drop table if exists it_scratch;
      create table it_scratch (id uuid primary key, created_at timestamptz not null);
      grant select, insert, delete on it_scratch to erp_app;
    `);
    t = await createTestApp();
    database = t.app.get(DatabaseService);
  });

  afterAll(async () => {
    await t.close();
    await asMigrator('drop table if exists it_scratch');
  });

  it('connects as the app user, which cannot bypass row-level security', async () => {
    const { rows } = await sql<{ user: string; bypass: boolean }>`
      select current_user as user, rolbypassrls as bypass from pg_roles where rolname = current_user
    `.execute(database.db);
    expect(rows[0]).toEqual({ user: 'erp_app', bypass: false });
  });

  it('cannot change the schema as the app user (SDD 16.6)', async () => {
    await expect(sql`create table should_fail (id int)`.execute(database.db)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('applies the tenant settings inside a transaction', async () => {
    const societyId = '00000000-0000-7000-8000-000000001001';
    const institutionIds = [
      '00000000-0000-7000-8000-000000002001',
      '00000000-0000-7000-8000-000000002002',
    ];
    const row = await database.transaction(
      { personId: '00000000-0000-7000-8000-000000003001', societyId, institutionIds, roleCode: 3 },
      async (tx) => {
        const { rows } = await sql<{
          person: string;
          society: string;
          institutions: string[];
          role: number;
          superAdmin: boolean;
        }>`
          select app_current_person_id() as person,
                 app_current_society_id() as society,
                 app_current_institution_ids() as institutions,
                 app_current_role_code() as role,
                 app_is_super_admin() as "superAdmin"
        `.execute(tx);
        return rows[0];
      },
    );
    expect(row).toEqual({
      person: '00000000-0000-7000-8000-000000003001',
      society: societyId,
      institutions: institutionIds,
      role: 3,
      superAdmin: false,
    });
  });

  it("never carries one transaction's tenant into the next on a pooled connection", async () => {
    await database.transaction(
      { societyId: '00000000-0000-7000-8000-000000001001' },
      async () => {},
    );
    const after = await sql<{ society: string | null; institutions: string[] }>`
      select app_current_society_id() as society, app_current_institution_ids() as institutions
    `.execute(database.db);
    expect(after.rows[0]).toEqual({ society: null, institutions: [] });
  });

  it('rolls back everything when the work throws', async () => {
    const id = '00000000-0000-7000-8000-00000000f001';
    await expect(
      database.transaction({}, async (tx) => {
        await sql`insert into it_scratch (id, created_at) values (${id}, now())`.execute(tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await sql<{
      n: number;
    }>`select count(*)::int as n from it_scratch where id = ${id}`.execute(database.db);
    expect(rows[0]?.n).toBe(0);
  });

  it('pages a cursor list without skipping rows that share a millisecond (API design 13.2)', async () => {
    // Five rows inside the same millisecond, apart only in microseconds.
    const ids = [1, 2, 3, 4, 5].map((n) => `00000000-0000-7000-8000-00000000c00${n}`);
    await sql`delete from it_scratch`.execute(database.db);
    for (const [index, id] of ids.entries()) {
      await sql`insert into it_scratch (id, created_at) values (${id}, ${`2026-10-23 04:25:00.12345${index}+00`}::timestamptz)`.execute(
        database.db,
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const position = cursor ? decodeCursor(cursor, {}) : null;
      let query = database.db
        .selectFrom(sql`it_scratch`.as('s'))
        .select([sql<string>`s.id::text`.as('id'), cursorTimestamp('s.created_at').as('cursorAt')])
        .orderBy(sql`s.created_at`, 'desc')
        .orderBy(sql`s.id`, 'desc')
        .limit(3);
      if (position) query = query.where(beforeCursor(position, 's.created_at', 's.id'));
      const page = cursorMeta(await query.execute(), 2, {});
      seen.push(...page.items.map((row) => row.id));
      cursor = page.meta.nextCursor;
    } while (cursor);

    expect(seen).toEqual(ids.toReversed());
  });

  it('keeps school days as YYYY-MM-DD and money as exact strings', async () => {
    const { rows } = await sql<{ day: string; amount: string }>`
      select date '2026-10-23' as day, 35000.10::numeric(12,2) as amount
    `.execute(database.db);
    expect(rows[0]).toEqual({ day: '2026-10-23', amount: '35000.10' });
  });

  it('reports ready when the database answers', async () => {
    const res = await request(t.app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
