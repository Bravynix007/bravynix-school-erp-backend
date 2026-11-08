import { Kysely, PostgresDialect, sql } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { FilesRepository } from '../../src/platform/files/files.repository.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { institutions, societies } from '../../src/seeds/two-worlds.js';
import { writeFilesSeed } from '../../src/seeds/files-seed.js';
import { countFileRows } from '../support/file-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const a1 = institutions.find((i) => i.key === 'A1')!;
const societyA = societies.find((s) => s.key === 'A')!;

const tenant = { personId: newId(), roleCode: 2, societyId: societyA.id, institutionIds: [a1.id] };

describe('the files table (DDD 9.12, 15.3)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  const repository = new FilesRepository();

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    await writeFilesSeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  const settle = (id: string, changes: object) =>
    database.transaction(tenant, (tx) => repository.settlePending(tx, id, changes));

  /** Tries to insert a file of A1 with these columns changed; the answer is the constraint that refused it, or null. */
  const insertRefusedBy = async (columns: object): Promise<string | null> => {
    const id = newId();
    try {
      await database.transaction(tenant, async (tx) => {
        await repository.insert(tx, {
          id,
          society_id: societyA.id,
          institution_id: a1.id,
          created_by: null,
          storage_bucket: 1,
          object_key: `t/${id}`,
          purpose: 3,
          content_type: 'image/jpeg',
          size_bytes: 10,
          ...columns,
        });
        throw new Error('rolled back');
      });
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint) return constraint;
      if ((error as Error).message !== 'rolled back') throw error;
    }
    return null;
  };

  it('keeps public purposes and public buckets together: only logos, event images and banners are public', async () => {
    expect(await insertRefusedBy({ storage_bucket: 2, purpose: 3 })).toBe(
      'ck_files_public_purpose',
    );
    expect(await insertRefusedBy({ storage_bucket: 1, purpose: 1 })).toBe(
      'ck_files_public_purpose',
    );
    expect(
      await insertRefusedBy({ storage_bucket: 2, purpose: 1, institution_id: null }),
    ).toBeNull();
  });

  it('limits a file to 5 MB, except an export, and to a positive size', async () => {
    expect(await insertRefusedBy({ size_bytes: 5_242_880 })).toBeNull();
    expect(await insertRefusedBy({ size_bytes: 5_242_881 })).toBe('ck_files_size');
    expect(await insertRefusedBy({ size_bytes: 0 })).toBe('ck_files_size');
    expect(await insertRefusedBy({ size_bytes: 9_000_000, purpose: 13 })).toBeNull();
  });

  it('takes only the content types and purposes the API allows', async () => {
    expect(await insertRefusedBy({ content_type: 'text/html' })).toBe('ck_files_content_type');
    expect(await insertRefusedBy({ purpose: 99 })).toBe('ck_files_purpose');
  });

  it('never gives two files the same object key', async () => {
    const key = `t/${newId()}`;
    const insert = (id: string) =>
      database.transaction(tenant, (tx) =>
        repository.insert(tx, {
          id,
          society_id: societyA.id,
          institution_id: a1.id,
          created_by: null,
          storage_bucket: 1,
          object_key: key,
          purpose: 3,
          content_type: 'image/jpeg',
          size_bytes: 10,
        }),
      );
    await insert(newId());
    await expect(insert(newId())).rejects.toMatchObject({ constraint: 'uq_files_object_key' });
  });

  it('is hidden by forced row-level security from the table owner and from a request with no tenant', async () => {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from files`.execute(
      ownerDb,
    );
    expect(rows[0]!.n).toBe(0);
    expect(await countFileRows(ownerDb)).toBeGreaterThan(0);
    expect(
      await database.transaction({}, (tx) => tx.selectFrom('files').selectAll().execute()),
    ).toEqual([]);
  });

  it('cannot be deleted by the app role: a file is removed from the store, and its row stays', async () => {
    await expect(
      database.transaction(tenant, (tx) =>
        sql`delete from files where society_id = ${societyA.id}`.execute(tx),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  describe('settling a Pending file', () => {
    it('changes a Pending file once, and never one that is Ready, Rejected or Deleted', async () => {
      const id = newId();
      await database.transaction(tenant, (tx) =>
        repository.insert(tx, {
          id,
          society_id: societyA.id,
          institution_id: a1.id,
          created_by: null,
          storage_bucket: 1,
          object_key: `t/${id}`,
          purpose: 3,
          content_type: 'image/jpeg',
          size_bytes: 10,
        }),
      );
      expect((await settle(id, { file_status: 2 }))?.file_status).toBe(2);
      expect(await settle(id, { file_status: 3 })).toBeUndefined();
      const stored = await database.transaction(tenant, (tx) => repository.find(tx, id));
      expect(stored?.file_status).toBe(2);
    });
  });
});
