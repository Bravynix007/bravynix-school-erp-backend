// QA for Phase 1 B1 (audit core): ways to lose or block audit entries that the
// engineer's suite does not try. Each test states the behaviour QA expects.
import pg from 'pg';
import { newId } from '../../src/common/ids/ids.js';
import { RequestContext } from '../../src/common/request-context/request-context.js';
import { AuditService } from '../../src/platform/audit/index.js';
import { DatabaseService } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

/** Runs statements in one transaction as the table owner, then rolls back, so nothing is left behind. */
async function asOwnerRolledBack(statements: string[]): Promise<unknown[]> {
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  const results: unknown[] = [];
  try {
    await client.query('begin');
    for (const statement of statements) results.push((await client.query(statement)).rows);
    return results;
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end();
  }
}

describe('QA: audit log', () => {
  let t: TestApp;
  let database: DatabaseService;
  let audit: AuditService;
  const societyA = newId();

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    t = await createTestApp({ clockStart: new Date().toISOString() });
    database = t.app.get(DatabaseService);
    audit = t.app.get(AuditService);
  });

  afterAll(async () => {
    await t.close();
  });

  const write = (after: Record<string, unknown>) =>
    database.transaction({ societyId: societyA }, (tx) =>
      audit.record(tx, {
        action: 'student.update',
        institutionId: null,
        entityId: newId(),
        societyId: societyA,
        before: {},
        after,
      }),
    );

  describe('append-only', () => {
    it('refuses TRUNCATE of the table even from its owner (the migration login)', async () => {
      await expect(asOwnerRolledBack(['truncate audit_logs'])).rejects.toThrow(
        /append-only|permission denied/,
      );
    });

    it('refuses TRUNCATE of a month partition from its owner', async () => {
      const [rows] = (await asOwnerRolledBack([
        `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
         where i.inhparent = 'audit_logs'::regclass order by c.relname limit 1`,
      ])) as [{ relname: string }[]];
      await expect(asOwnerRolledBack([`truncate ${rows[0]!.relname}`])).rejects.toThrow(
        /append-only|permission denied/,
      );
    });
  });

  describe('default partition', () => {
    it('a stray row in the default partition does not stop the upkeep from making later months', async () => {
      // A row for May 2041 lands in the default partition (the clock was wrong, or the upkeep missed a run).
      // The upkeep then runs for April to July 2041 and must still make all four months.
      const made = asOwnerRolledBack([
        `insert into audit_logs (action, created_at) values ('qa.stray', '2041-05-10T00:00:00Z')`,
        `select maintenance.ensure_audit_partitions('2041-04-01', 3) as made`,
        `select count(*)::int as count from pg_class where relkind = 'r' and relname like 'audit\\_logs\\_2041\\_%'`,
      ]);
      await expect(made).resolves.toEqual([[], [{ made: 4 }], [{ count: 4 }]]);
    });
  });

  describe('values the database cannot store', () => {
    it('a NUL character in a changed value does not fail the change it describes', async () => {
      await expect(write({ note: 'pasted from a PDF\u0000' })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });

    it('a broken surrogate in a changed value does not fail the change it describes', async () => {
      await expect(write({ note: 'cut emoji \ud83d' })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });

    it('an IPv6 address with a zone does not fail the change', async () => {
      const result = RequestContext.run(
        { requestId: newId(), language: 'en', ipAddress: 'fe80::1%eth0' },
        () =>
          database.transaction({ societyId: societyA }, (tx) =>
            audit.record(tx, {
              action: 'student.update',
              institutionId: null,
              entityId: newId(),
              societyId: societyA,
            }),
          ),
      );
      await expect(result).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('reading across tenants', () => {
    it('a caller who sets another Society’s ID in the institution list still reads only their own Society', async () => {
      const societyB = newId();
      const entityId = newId();
      await database.transaction({ societyId: societyB }, (tx) =>
        audit.record(tx, {
          action: 'student.update',
          institutionId: null,
          entityId,
          societyId: societyB,
        }),
      );
      const rows = await database.transaction(
        { societyId: societyA, institutionIds: [societyB] },
        (tx) =>
          tx.selectFrom('audit_logs').select('id').where('entity_id', '=', entityId).execute(),
      );
      expect(rows).toEqual([]);
    });

    it('records whether an Institution-scoped caller sees Society-level entries (question for AUD-01)', async () => {
      const institution = newId();
      const entityId = newId();
      await database.transaction({ societyId: societyA, institutionIds: [institution] }, (tx) =>
        audit.record(tx, {
          action: 'society.pricing.update',
          entityId,
          societyId: societyA,
          institutionId: null,
        }),
      );
      const rows = await database.transaction(
        { societyId: societyA, institutionIds: [institution] },
        (tx) =>
          tx.selectFrom('audit_logs').select('id').where('entity_id', '=', entityId).execute(),
      );
      // Recorded, not asserted: B1 has no read endpoint, so this documents what an Institution Admin would see.
      console.log(`QA: Institution-scoped caller sees ${rows.length} Society-level entry`);
    });
  });
});
