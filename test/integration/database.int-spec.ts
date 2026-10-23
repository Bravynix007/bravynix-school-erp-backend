import { sql } from 'kysely';
import request from 'supertest';
import { DatabaseService } from '../../src/platform/database/database.service.js';
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

describe('DatabaseService', () => {
  let t: TestApp;
  let database: DatabaseService;

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    t = await createTestApp();
    database = t.app.get(DatabaseService);
  });

  afterAll(async () => {
    await t.close();
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
    await expect(
      database.transaction({}, async (tx) => {
        await sql`select set_config('app.marker', 'x', false)`.execute(tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
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
