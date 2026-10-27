import { Kysely, PostgresDialect, sql } from 'kysely';
import { TenantAccessGate } from '../../src/common/auth/tenant-access-gate.js';
import { RoleCode } from '../../src/common/auth/roles.js';
import { DatabaseService, type Tx, type TenantContext } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { institutions, personaByKey, societies } from '../../src/seeds/two-worlds.js';
import { clearBlocks, setBlock } from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

const societyA = societies.find((s) => s.key === 'A')!;
const societyB = societies.find((s) => s.key === 'B')!;
const institutionByKey = (key: string) => institutions.find((i) => i.key === key)!;
const instA1 = institutionByKey('A1');
const instA2 = institutionByKey('A2');
const instB1 = institutionByKey('B1');
const superAdmin = personaByKey('SA1');
const owner = personaByKey('SO-A1');
const asSuperAdmin: TenantContext = { personId: superAdmin.id, roleCode: RoleCode.SuperAdmin };
const asOwnerOf = (society: { id: string }): TenantContext => ({
  personId: owner.id,
  roleCode: RoleCode.SocietyOwner,
  societyId: society.id,
});
const caller = (society: { id: string } | null, roleCode: 1 | 2 = 2) => ({
  personId: owner.id,
  sessionId: owner.id,
  roleCode,
  societyId: society?.id ?? null,
  clientType: 'mobile' as const,
  viaSupportAccess: false,
});

const edit = (id: string) => (tx: Tx) =>
  tx
    .updateTable('societies')
    .set({ description: 'Our schools' })
    .where('id', '=', id)
    .executeTakeFirst();

let ownerDb: Kysely<unknown>;
let t: TestApp;
let database: DatabaseService;

/** Runs `work` as the app role with this tenant, then rolls the transaction back. */
const inRolledBack = async <T>(tenant: TenantContext, work: (tx: Tx) => Promise<T>): Promise<T> => {
  let result!: T;
  await database
    .transaction(tenant, async (tx) => {
      result = await work(tx);
      throw new Error('rollback');
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'rollback') throw error;
    });
  return result;
};

const probe = async (tenant: TenantContext, statement: (tx: Tx) => Promise<unknown>) => {
  try {
    const result = await inRolledBack(tenant, statement);
    const rows =
      (result as { numAffectedRows?: bigint; numUpdatedRows?: bigint } | undefined) ?? {};
    return `ok ${String(rows.numUpdatedRows ?? rows.numAffectedRows ?? '')}`.trim();
  } catch (error) {
    return `refused: ${(error as Error).message.slice(0, 80)}`;
  }
};
const as = (
  roleCode: number,
  society: { id: string },
  institutionIds: string[] = [],
): TenantContext => ({
  personId: owner.id,
  roleCode: roleCode as RoleCode,
  societyId: society.id,
  institutionIds,
});

describe('QA: tenancy (B6)', () => {
  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
  });
  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  it('records what each role may write at the database level (for the endpoint rules in B7 and B9)', async () => {
    const report: Record<string, string> = {};
    const ownerA = asOwnerOf(societyA);
    report['owner: deactivate own Society (status 0)'] = await probe(ownerA, (tx) =>
      tx
        .updateTable('societies')
        .set({ status: 0 })
        .where('id', '=', societyA.id)
        .executeTakeFirst(),
    );
    report['owner: rewrite created_at/created_by of own Society'] = await probe(ownerA, (tx) =>
      tx
        .updateTable('societies')
        .set({ created_at: sql`'2000-01-01'::timestamptz`, created_by: superAdmin.id })
        .where('id', '=', societyA.id)
        .executeTakeFirst(),
    );
    report['owner: change own Society id'] = await probe(ownerA, (tx) =>
      sql`update societies set id = gen_random_uuid() where id = ${societyA.id}`.execute(tx),
    );
    report['owner: block the staff of an Institution'] = await probe(ownerA, (tx) =>
      tx
        .insertInto('access_blocks')
        .values({
          society_id: societyA.id,
          institution_id: instA1.id,
          section: 2,
          reason: 'x',
          created_by: owner.id,
        })
        .executeTakeFirst(),
    );
    const adminA1 = as(3, societyA, [instA1.id]);
    report['Institution Admin of A1: edit the Society A profile'] = await probe(
      adminA1,
      edit(societyA.id),
    );
    report['Institution Admin of A1: rename Institution A2'] = await probe(adminA1, (tx) =>
      tx
        .updateTable('institutions')
        .set({ name: 'Renamed' })
        .where('id', '=', instA2.id)
        .executeTakeFirst(),
    );
    report['Teacher (role 4) in A: edit the Society A profile'] = await probe(
      as(4, societyA),
      edit(societyA.id),
    );
    report['Parent (role 5) with Society A set: edit the Society A profile'] = await probe(
      as(5, societyA),
      edit(societyA.id),
    );
    report['owner of A: edit Society B'] = await probe(ownerA, edit(societyB.id));
    report['owner of A: rename B1'] = await probe(ownerA, (tx) =>
      tx
        .updateTable('institutions')
        .set({ name: 'Renamed' })
        .where('id', '=', instB1.id)
        .executeTakeFirst(),
    );
    console.log(
      `QA write matrix:\n${Object.entries(report)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')}`,
    );
    expect(report['owner of A: edit Society B']).toBe('ok 0');
    expect(report['owner of A: rename B1']).toBe('ok 0');
    expect(report['owner: change own Society id']).toMatch(/^refused/);
    // Only Super Admin sets a block (PRD 9.4).
    expect(report['owner: block the staff of an Institution']).toMatch(/^refused/);
  });

  it('a version cannot be set back by the owner', async () => {
    const version = await inRolledBack(asOwnerOf(societyA), async (tx) => {
      await tx
        .updateTable('societies')
        .set({ version: 1, description: 'x' })
        .where('id', '=', societyA.id)
        .execute();
      return (
        await tx
          .selectFrom('societies')
          .select('version')
          .where('id', '=', societyA.id)
          .executeTakeFirstOrThrow()
      ).version;
    });
    const before = (
      await database.transaction(asSuperAdmin, (tx) =>
        tx
          .selectFrom('societies')
          .select('version')
          .where('id', '=', societyA.id)
          .executeTakeFirstOrThrow(),
      )
    ).version;
    expect(version).toBe(before + 1);
  });

  it('blocking the Owners of Society A does not touch an owner acting in Society B, nor role 3 or 5', async () => {
    await setBlock(ownerDb, societyA.id, null, 1, true);
    const gate = t.app.get(TenantAccessGate);
    expect(await gate.blockedSection(caller(societyA))).toBe(1);
    expect(await gate.blockedSection(caller(societyB))).toBeNull();
    // Staff and parents are stopped by their own sections, never by the Owners'.
    expect(await gate.blockedSection({ ...caller(societyA), roleCode: 5 })).toBeNull();
    await clearBlocks(ownerDb);
  });
});
