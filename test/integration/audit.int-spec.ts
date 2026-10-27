import { sql } from 'kysely';
import pg from 'pg';
import { newId } from '../../src/common/ids/ids.js';
import { RequestContext } from '../../src/common/request-context/request-context.js';
import { AuditOutcome, AuditService } from '../../src/platform/audit/index.js';
import { DatabaseService } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

/** The month the tests write into; its partition is made in beforeAll. */
const TEST_INSTANT = '2030-03-15T10:00:00.000Z';
const TEST_PARTITION = 'audit_logs_2030_03';

/** Runs SQL as the migrator (the table owner), optionally with tenant settings. */
async function asOwner<T extends pg.QueryResultRow = pg.QueryResultRow>(
  statement: string,
  params: unknown[] = [],
  settings: { societyId?: string; institutionIds?: string[] } = {},
): Promise<pg.QueryResult<T>> {
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('app.society_id', $1, true), set_config('app.institution_ids', $2, true)`,
      [settings.societyId ?? '', (settings.institutionIds ?? []).join(',')],
    );
    const result = await client.query<T>(statement, params);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

describe('audit log', () => {
  let t: TestApp;
  let database: DatabaseService;
  let audit: AuditService;
  const societyA = newId();
  const societyB = newId();
  const institutionA1 = newId();
  const institutionA2 = newId();

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    await asOwner(`select maintenance.ensure_audit_partitions('2030-03-01', 0)`);
    t = await createTestApp({ clockStart: TEST_INSTANT });
    database = t.app.get(DatabaseService);
    audit = t.app.get(AuditService);
  });

  afterAll(async () => {
    await t.close();
  });

  const insert = (columns: string, values: unknown[]) =>
    database.transaction({}, (tx) =>
      sql`insert into audit_logs (id, ${sql.raw(columns)}) values (${newId()}, ${sql.join(values)})`.execute(
        tx,
      ),
    );

  const readBack = (societyId: string, institutionIds: string[], entityId: string) =>
    database.transaction({ societyId, institutionIds }, (tx) =>
      tx.selectFrom('audit_logs').selectAll().where('entity_id', '=', entityId).execute(),
    );

  describe('writing', () => {
    it('stores who, what, when and the changed values, and the owner’s Society can read it', async () => {
      const entityId = newId();
      const personId = newId();
      await RequestContext.run(
        {
          requestId: newId(),
          language: 'en',
          personId,
          societyId: societyA,
          roleCode: 3,
          displayName: 'Asha Rao',
          ipAddress: '203.0.113.7',
          userAgent: 'BravyNixApp/1.0',
        },
        () =>
          database.transaction(
            { personId, societyId: societyA, institutionIds: [institutionA1], roleCode: 3 },
            (tx) =>
              audit.record(tx, {
                action: 'student.update',
                entityType: 'student',
                entityId,
                institutionId: institutionA1,
                before: { firstName: 'Diya', rollNumber: 7, otp: '111111' },
                after: { firstName: 'Diya R', rollNumber: 7, otp: '222222' },
              }),
          ),
      );

      const [row] = await readBack(societyA, [institutionA1], entityId);
      expect(row).toMatchObject({
        society_id: societyA,
        institution_id: institutionA1,
        actor_user_id: personId,
        actor_role_code: 3,
        actor_display_name: 'Asha Rao',
        action: 'student.update',
        entity_type: 'student',
        outcome: AuditOutcome.Success,
        via_support_access: false,
        ip_address: '203.0.113.7',
        user_agent: 'BravyNixApp/1.0',
        old_values: { firstName: 'Diya' },
        new_values: { firstName: 'Diya R' },
      });
      expect(row?.created_at.toISOString()).toBe(TEST_INSTANT);
      expect(row?.request_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('keeps another Society from reading it, and an Institution outside the caller’s scope', async () => {
      const entityId = newId();
      await database.transaction(
        { societyId: societyA, institutionIds: [institutionA1, institutionA2] },
        (tx) =>
          audit.record(tx, {
            action: 'student.create',
            entityId,
            societyId: societyA,
            institutionId: institutionA2,
          }),
      );
      expect(await readBack(societyA, [institutionA1, institutionA2], entityId)).toHaveLength(1);
      expect(await readBack(societyB, [institutionA1, institutionA2], entityId)).toHaveLength(0);
      // An admin of A1 alone does not see A2's entries.
      expect(await readBack(societyA, [institutionA1], entityId)).toHaveLength(0);
      // No scope at all sees nothing.
      expect(await readBack(societyA, [], entityId)).toHaveLength(0);
    });

    it('refuses an entry for another Society or an Institution outside the caller’s scope', async () => {
      await expect(
        database.transaction({ societyId: societyA, institutionIds: [institutionA1] }, (tx) =>
          audit.record(tx, { action: 'student.create', institutionId: null, societyId: societyB }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        database.transaction({ societyId: societyA, institutionIds: [institutionA1] }, (tx) =>
          audit.record(tx, {
            action: 'student.create',
            societyId: societyA,
            institutionId: institutionA2,
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('refuses an entry written with no scope at all that names a Society', async () => {
      await expect(
        database.transaction({}, (tx) =>
          audit.record(tx, { action: 'student.create', institutionId: null, societyId: societyA }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('refuses a tenant action written with no Society, which the tenant could never see (S2)', async () => {
      await expect(
        RequestContext.run({ requestId: newId(), language: 'en', societyId: societyA }, () =>
          database.transaction({ societyId: societyA }, (tx) =>
            audit.record(tx, { action: 'student.update', societyId: null, institutionId: null }),
          ),
        ),
      ).rejects.toThrow(/needs a Society/);
    });

    it('accepts an entry that belongs to no Society (a login), which no tenant can read', async () => {
      const entityId = newId();
      await database.transaction({}, (tx) =>
        audit.record(tx, {
          action: 'auth.login',
          institutionId: null,
          societyId: null,
          entityType: 'user',
          entityId,
          actor: { userId: newId(), roleCode: 4, displayName: 'Ravi' },
        }),
      );
      expect(await readBack(societyA, [institutionA1], entityId)).toHaveLength(0);
      const stored = await asOwner(
        `select action, society_id from ${TEST_PARTITION} where entity_id = $1`,
        [entityId],
      );
      expect(stored.rows).toEqual([{ action: 'auth.login', society_id: null }]);
    });

    it('commits with the change it describes, and rolls back with it', async () => {
      const entityId = newId();
      await expect(
        database.transaction({ societyId: societyA }, async (tx) => {
          await audit.record(tx, {
            action: 'student.delete',
            institutionId: null,
            entityId,
            societyId: societyA,
          });
          throw new Error('the change failed');
        }),
      ).rejects.toThrow('the change failed');
      expect(await readBack(societyA, [], entityId)).toHaveLength(0);
      const stored = await asOwner(
        `select count(*)::int as n from ${TEST_PARTITION} where entity_id = $1`,
        [entityId],
      );
      expect(stored.rows[0]?.n).toBe(0);
    });

    it('fails the change when the entry cannot be written', async () => {
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          audit.record(tx, { action: 'Not A Valid Action', institutionId: null }),
        ),
      ).rejects.toThrow(/Invalid audit action/);
    });

    it('records a denied or failed attempt as such', async () => {
      const entityId = newId();
      await database.transaction({ societyId: societyA }, (tx) =>
        audit.record(tx, {
          action: 'access.revoke',
          institutionId: null,
          entityId,
          societyId: societyA,
          outcome: AuditOutcome.Denied,
        }),
      );
      const [row] = await readBack(societyA, [], entityId);
      expect(row?.outcome).toBe(2);
    });
  });

  describe('append-only (DDD 15.8)', () => {
    let rowId: string;
    beforeAll(async () => {
      const entityId = newId();
      rowId = await database.transaction({ societyId: societyA }, (tx) =>
        audit.record(tx, {
          action: 'society.update',
          institutionId: null,
          entityId,
          societyId: societyA,
        }),
      );
    });

    it('lets the app role insert and read only', async () => {
      const { rows } = await sql<Record<string, boolean>>`
        select has_table_privilege('erp_app', 'audit_logs', 'SELECT') as sel,
               has_table_privilege('erp_app', 'audit_logs', 'INSERT') as ins,
               has_table_privilege('erp_app', 'audit_logs', 'UPDATE') as upd,
               has_table_privilege('erp_app', 'audit_logs', 'DELETE') as del,
               has_table_privilege('erp_app', 'audit_logs', 'TRUNCATE') as trunc
      `.execute(database.db);
      expect(rows[0]).toEqual({ sel: true, ins: true, upd: false, del: false, trunc: false });
    });

    it('refuses an update, a delete and a truncate from the app role', async () => {
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`update audit_logs set reason = 'edited' where id = ${rowId}`.execute(tx),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`delete from audit_logs where id = ${rowId}`.execute(tx),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(sql`truncate audit_logs`.execute(database.db)).rejects.toThrow(
        /permission denied/,
      );
    });

    it('has no update or delete policy, so even the table owner changes no row through the table', async () => {
      const update = await asOwner(
        `update audit_logs set reason = 'edited' where id = $1`,
        [rowId],
        {
          societyId: societyA,
        },
      );
      const del = await asOwner(`delete from audit_logs where id = $1`, [rowId], {
        societyId: societyA,
      });
      expect([update.rowCount, del.rowCount]).toEqual([0, 0]);
      const kept = await asOwner(`select reason from audit_logs where id = $1`, [rowId], {
        societyId: societyA,
      });
      expect(kept.rows).toEqual([{ reason: null }]);
    });

    it('has the rejecting trigger on the table and on every partition', async () => {
      const { rows } = await asOwner<{ name: string; guarded: boolean }>(`
        select c.relname as name,
               exists (
                 select 1 from pg_trigger g
                 where g.tgrelid = c.oid and g.tgname like '%append_only' and not g.tgisinternal
               ) as guarded
        from pg_class c
        where c.relkind in ('r', 'p')
          and (c.relname = 'audit_logs' or (c.relispartition and c.relname like 'audit\\_logs\\_%'))
      `);
      expect(rows.length).toBeGreaterThanOrEqual(6);
      expect(rows.filter((row) => !row.guarded)).toEqual([]);
    });

    it('refuses TRUNCATE even from the table owner, on the table and on every kind of partition (S3)', async () => {
      await asOwner(`select maintenance.ensure_audit_partitions('2032-01-01', 0)`);
      for (const target of [
        'audit_logs',
        TEST_PARTITION,
        'audit_logs_default',
        'audit_logs_2032_01',
      ]) {
        await expect(asOwner(`truncate ${target}`)).rejects.toThrow(/append-only/);
      }
      const { rows } = await asOwner<{ name: string; guarded: boolean }>(`
        select c.relname as name,
               exists (
                 select 1 from pg_trigger g
                 where g.tgrelid = c.oid and g.tgname = 'trg_audit_logs_no_truncate' and not g.tgisinternal
               ) as guarded
        from pg_class c
        where c.relkind in ('r', 'p')
          and (c.relname = 'audit_logs' or (c.relispartition and c.relname like 'audit\\_logs\\_%'))
      `);
      expect(rows.length).toBeGreaterThanOrEqual(6);
      expect(rows.filter((row) => !row.guarded)).toEqual([]);
      await asOwner(`drop table if exists audit_logs_2032_01`);
    });

    it('also refuses a change made directly on a partition', async () => {
      await expect(
        asOwner(`update ${TEST_PARTITION} set reason = 'edited' where id = $1`, [rowId]),
      ).rejects.toThrow(/append-only/);
      await expect(asOwner(`delete from ${TEST_PARTITION} where id = $1`, [rowId])).rejects.toThrow(
        /append-only/,
      );
    });

    it('rejects a malformed row at the database too', async () => {
      await expect(insert('action', ['Not Valid'])).rejects.toThrow(/ck_audit_logs_action/);
      await expect(insert('action, outcome', ['a.b', 9])).rejects.toThrow(/ck_audit_logs_outcome/);
      await expect(insert('action, actor_role_code', ['a.b', 6])).rejects.toThrow(
        /ck_audit_logs_role_code/,
      );
      await expect(insert('action, institution_id', ['a.b', newId()])).rejects.toThrow(
        /ck_audit_logs_institution_needs_society/,
      );
    });
  });

  describe('partitions (DDD 14.5)', () => {
    it('are made ahead, once, and rows land in their month', async () => {
      // Partitions of earlier runs hold test rows, so drop them (the app role cannot).
      for (const month of ['2031_01', '2031_02', '2031_03']) {
        await asOwner(`drop table if exists audit_logs_${month}`);
      }
      const first = await asOwner<{ made: number }>(
        `select maintenance.ensure_audit_partitions('2031-01-15', 2) as made`,
      );
      expect(first.rows[0]?.made).toBe(3);
      const again = await asOwner<{ made: number }>(
        `select maintenance.ensure_audit_partitions('2031-01-31', 2) as made`,
      );
      expect(again.rows[0]?.made).toBe(0);

      t.clock.set('2031-02-10T10:00:00.000Z');
      const entityId = newId();
      await database.transaction({ societyId: societyA }, (tx) =>
        audit.record(tx, {
          action: 'society.update',
          institutionId: null,
          entityId,
          societyId: societyA,
        }),
      );
      t.clock.set(TEST_INSTANT);
      const where = await asOwner<{ part: string }>(
        `select tableoid::regclass::text as part from audit_logs where entity_id = $1`,
        [entityId],
        { societyId: societyA },
      );
      expect(where.rows[0]?.part).toBe('audit_logs_2031_02');
    });

    it('send a row with no matching month to the default partition rather than failing', async () => {
      t.clock.set('2040-07-01T00:00:00.000Z');
      const entityId = newId();
      await database.transaction({ societyId: societyA }, (tx) =>
        audit.record(tx, {
          action: 'society.update',
          institutionId: null,
          entityId,
          societyId: societyA,
        }),
      );
      t.clock.set(TEST_INSTANT);
      const where = await asOwner<{ part: string }>(
        `select tableoid::regclass::text as part from audit_logs where entity_id = $1`,
        [entityId],
        { societyId: societyA },
      );
      expect(where.rows[0]?.part).toBe('audit_logs_default');
    });

    it('are unreachable by name from the app role, because the parent’s policies would not apply', async () => {
      const { rows } = await sql<{ name: string; can: boolean }>`
        select c.relname as name,
               has_table_privilege('erp_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as can
        from pg_class c
        where c.relispartition and c.relname like 'audit\_logs\_%'
      `.execute(database.db);
      expect(rows.length).toBeGreaterThanOrEqual(5);
      expect(rows.filter((row) => row.can)).toEqual([]);
      await expect(sql.raw(`select * from ${TEST_PARTITION}`).execute(database.db)).rejects.toThrow(
        /permission denied/,
      );
    });

    it('cannot be made by the app role, which has no rights on the maintenance function', async () => {
      await expect(
        sql`select maintenance.ensure_audit_partitions(current_date, 1)`.execute(database.db),
      ).rejects.toThrow(/permission denied/);
    });

    it('move a stray default-partition row into its month, keep it, and leave the default attached (D1)', async () => {
      for (const month of ['04', '05', '06', '07']) {
        await asOwner(`drop table if exists audit_logs_2045_${month}`);
      }
      const strayId = newId();
      await asOwner(
        `insert into audit_logs (id, action, created_at) values ($1, 'qa.stray', '2045-05-10T00:00:00Z')`,
        [strayId],
      );
      const before = await asOwner<{ part: string }>(
        `select tableoid::regclass::text as part from audit_logs_default where id = $1`,
        [strayId],
      );
      expect(before.rows).toEqual([{ part: 'audit_logs_default' }]);

      const made = await asOwner<{ made: number }>(
        `select maintenance.ensure_audit_partitions('2045-04-01', 3) as made`,
      );
      expect(made.rows[0]?.made).toBe(4);

      const kept = await asOwner<{ part: string }>(
        `select tableoid::regclass::text as part from audit_logs_2045_05 where id = $1`,
        [strayId],
      );
      expect(kept.rows).toEqual([{ part: 'audit_logs_2045_05' }]);
      const left = await asOwner<{ n: number }>(
        `select count(*)::int as n from audit_logs_default where id = $1`,
        [strayId],
      );
      expect(left.rows[0]?.n).toBe(0);

      // The default partition is attached again and still guarded.
      const attached = await asOwner<{ bound: string }>(
        `select pg_get_expr(relpartbound, oid) as bound from pg_class where relname = 'audit_logs_default'`,
      );
      expect(attached.rows).toEqual([{ bound: 'DEFAULT' }]);
      await expect(asOwner(`truncate audit_logs_default`)).rejects.toThrow(/append-only/);
      await expect(asOwner(`delete from audit_logs_default`)).rejects.toThrow(/append-only/);
    });

    it('refuses an out-of-range look-ahead', async () => {
      await expect(
        asOwner(`select maintenance.ensure_audit_partitions('2032-01-01', 25)`),
      ).rejects.toThrow(/months_ahead/);
      await expect(
        asOwner(`select maintenance.ensure_audit_partitions('2032-01-01', -1)`),
      ).rejects.toThrow(/months_ahead/);
    });
  });
});

describe('rolling back', () => {
  it('is refused in production, so accounts and the audit history cannot be erased', async () => {
    await runMigrations(migrationUrl, 'latest');
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const result = await runMigrations(migrationUrl, 'down');
      // 'down' steps back the latest migration, whichever it is.
      expect(String(result.error)).toMatch(/Refusing to drop .* in production/);
      // Every migration that holds accounts, logins or history carries the same guard.
      const guarded = [
        [
          await import('../../src/platform/database/migrations/2026_10_25_0002_audit_logs.js'),
          /audit_logs/,
        ],
        [
          await import('../../src/platform/database/migrations/2026_10_25_0003_identity_users_otp.js'),
          /identity tables/,
        ],
        [
          await import('../../src/platform/database/migrations/2026_10_25_0004_identity_sessions.js'),
          /session tables/,
        ],
        [
          await import('../../src/platform/database/migrations/2026_10_26_0006_tenancy_core.js'),
          /tenancy tables/,
        ],
        [
          await import('../../src/platform/database/migrations/2026_10_26_0007_identity_mfa.js'),
          /authenticator tables/,
        ],
        [
          await import('../../src/platform/database/migrations/2026_10_27_0011_tenancy_access_blocks.js'),
          /access_blocks/,
        ],
      ] as const;
      for (const [migration, name] of guarded) {
        await expect(migration.down(null as never)).rejects.toThrow(
          new RegExp(`Refusing to drop .*${name.source}.* in production`),
        );
      }
    } finally {
      process.env.NODE_ENV = previous;
    }
    const { rows } = await asOwner<{ found: boolean }>(
      `select to_regclass('public.audit_logs') is not null as found`,
    );
    expect(rows[0]?.found).toBe(true);
  });
});

describe('tenant tables (DDD 15.3 checks in the build)', () => {
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

  /**
   * Identity tables are global (DDD 15.3 "None"): the login reads a person's
   * grants before any Society is known. `role_assignments` names a Society as
   * the scope of a grant; it is not a tenant row. The list stays short and
   * explicit so a new table cannot slip out of the check. Any column ending in
   * `society_id` or `institution_id` counts, so `target_society_id` is caught too;
   * `auth_sessions.active_society_id` is the session's own choice of context.
   */
  const globalIdentityTables = ['role_assignments', 'auth_sessions'];
  /** The Society is its own tenant, so `societies` has an `id` where others have a `society_id`. */
  const tenantRoots = ['societies'];

  const tenantTables = async () => {
    const { rows } = await sql<{ name: string; rls: boolean; forced: boolean }>`
      select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and not c.relispartition
        and c.relname <> all (${globalIdentityTables})
        and (
          c.relname = any (${tenantRoots})
          or exists (
            select 1 from pg_attribute a
            where a.attrelid = c.oid and a.attname ~ '(^|_)(society|institution)_id$' and not a.attisdropped
          )
        )
      order by c.relname
    `.execute(database.db);
    return rows;
  };

  it('has forced row-level security on every table with a society_id or institution_id', async () => {
    const tables = await tenantTables();
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['audit_logs', 'institutions', 'societies']),
    );
    expect(tables.filter((table) => !table.rls || !table.forced)).toEqual([]);
  });

  it('shows the app role no rows from any of them when no tenant is set', async () => {
    // A tenant-less row exists, to prove the policy hides it rather than the table being empty.
    await database.transaction({}, (tx) =>
      t.app
        .get(AuditService)
        .record(tx, { action: 'auth.login', institutionId: null, societyId: null }),
    );
    for (const table of await tenantTables()) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from ${sql.table(table.name)}
      `.execute(database.db);
      expect({ table: table.name, rows: rows[0]?.n }).toEqual({ table: table.name, rows: 0 });
    }
  });
});
