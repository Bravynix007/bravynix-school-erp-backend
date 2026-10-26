import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { AuditService } from '../../src/platform/audit/index.js';
import { DatabaseService, type TenantContext } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { institutions, personaByKey, societies } from '../../src/seeds/two-worlds.js';
import { FixtureModule } from '../support/fixture.module.js';
import { signInAs } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/**
 * The tenant-isolation suite (SDD 10.3 step 6, QA strategy 4): every tenant
 * table and every tenant-scoped endpoint so far, tried from each side of the
 * two worlds. A new tenant table or endpoint joins the checks below; a table
 * with no rows in both worlds fails here until its seed rows are written, so a
 * check can never pass by looking at an empty table.
 */
const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

const world = (key: string) => societies.find((s) => s.key === key)!;
const inst = (key: string) => institutions.find((i) => i.key === key)!;
const [socA, socB] = [world('A'), world('B')];
const [a1, a2, b1] = [inst('A1'), inst('A2'), inst('B1')];
const missing = '00000000-0000-7000-8000-00000000ffff';

/** Who signs in, as which role, and the Institutions their grant names. */
const callers = {
  ownerA: { persona: 'SO-A1', role: 2, society: socA, grants: [] as string[] },
  ownerB: { persona: 'SO-B1', role: 2, society: socB, grants: [] as string[] },
  adminA1: { persona: 'IA-A1', role: 3, society: socA, grants: [a1.id] },
  adminA12: { persona: 'IA-A12', role: 3, society: socA, grants: [a1.id, a2.id] },
  adminB1: { persona: 'IA-B1', role: 3, society: socB, grants: [b1.id] },
} as const;
type CallerKey = keyof typeof callers;

let ownerDb: Kysely<unknown>;
let t: TestApp;
let database: DatabaseService;
const tokens = {} as Record<CallerKey, string>;

const get = (path: string, key: CallerKey) =>
  request(t.app.getHttpServer()).get(path).set('Authorization', `Bearer ${tokens[key]}`);
const rename = (institutionId: string, key: CallerKey, name: string) =>
  request(t.app.getHttpServer())
    .post(`/v1/fixtures/tenant/institutions/${institutionId}/rename`)
    .set('Authorization', `Bearer ${tokens[key]}`)
    .send({ name });

const clearLogins = async () => {
  for (const table of [
    'refresh_tokens',
    'auth_sessions',
    'otp_challenges',
    'public_call_counters',
    'login_lockouts',
  ]) {
    await sql`delete from ${sql.table(table)}`.execute(ownerDb);
  }
};

const setInstitution = (id: string, fields: 'paused' | 'inactive' | 'active') =>
  ownerDb.transaction().execute(async (tx) => {
    await sql`select set_config('app.role_code', '1', true)`.execute(tx);
    await sql`
      update institutions set
        status = ${fields === 'inactive' ? 0 : 1},
        access_paused_at = ${fields === 'paused' ? sql`now()` : null},
        access_paused_by = ${fields === 'paused' ? personaByKey('SA1').id : null},
        access_pause_reason = ${fields === 'paused' ? 'Dues unpaid' : null}
      where id = ${id}
    `.execute(tx);
  });

const tenantTables = async () => {
  const { rows } = await sql<{ name: string; hasSociety: boolean; hasInstitution: boolean }>`
    select c.relname as name,
      exists (select 1 from pg_attribute a where a.attrelid = c.oid
        and a.attname = 'society_id' and not a.attisdropped) as "hasSociety",
      exists (select 1 from pg_attribute a where a.attrelid = c.oid
        and a.attname = 'institution_id' and not a.attisdropped) as "hasInstitution"
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      and c.relname <> all (array['role_assignments', 'auth_sessions'])
      and (c.relname = 'societies' or exists (
        select 1 from pg_attribute a where a.attrelid = c.oid
          and a.attname ~ '(^|_)(society|institution)_id$' and not a.attisdropped))
    order by c.relname
  `.execute(ownerDb);
  return rows;
};

const visible = async (table: string, tenant: TenantContext) => {
  const { rows } = await database.transaction(tenant, (tx) =>
    sql<Record<string, string | null>>`select * from ${sql.table(table)}`.execute(tx),
  );
  return rows;
};

const strip = ({ body }: { body: Record<string, unknown> }) => ({
  ...body,
  requestId: undefined,
});

describe('tenant isolation', () => {
  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    await clearLogins();
    // Role 3 grants need a staff record, which arrives with the People module.
    for (const caller of Object.values(callers)) {
      for (const institutionId of caller.grants) {
        await sql`
          insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
          values (${personaByKey(caller.persona).id}, 3, ${caller.society.id}, ${institutionId}, gen_random_uuid())
        `.execute(ownerDb);
      }
    }
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
    for (const [key, caller] of Object.entries(callers)) {
      tokens[key as CallerKey] = await signInAs(t, personaByKey(caller.persona).email, {
        roleCode: caller.role,
        societyId: caller.society.id,
      });
    }
    // One audit entry in each world, so the table checks see rows on both sides.
    const audit = t.app.get(AuditService);
    for (const [society, institution] of [
      [socA, a1],
      [socB, b1],
    ] as const) {
      await database.transaction(
        { societyId: society.id, institutionIds: [institution.id] },
        (tx) =>
          audit.record(tx, {
            action: 'isolation.probe',
            societyId: society.id,
            institutionId: institution.id,
          }),
      );
    }
  });

  afterAll(async () => {
    await t.close();
    await clearLogins();
    for (const caller of Object.values(callers)) {
      if (caller.grants.length === 0) continue;
      await sql`delete from role_assignments where user_id = ${personaByKey(caller.persona).id} and role_code = 3`.execute(
        ownerDb,
      );
    }
    await ownerDb.destroy();
  });

  afterEach(async () => {
    for (const { id } of institutions) await setInstitution(id, 'active');
  });

  describe('every tenant table, read as the app role', () => {
    it('covers the tables built so far', async () => {
      expect((await tenantTables()).map((table) => table.name)).toEqual([
        'audit_logs',
        'institutions',
        'societies',
      ]);
    });

    it.each([
      ['owner of A', socA, [a1.id, a2.id]],
      ['owner of B', socB, [b1.id]],
      ['admin of A1', socA, [a1.id]],
      ['admin of B1', socB, [b1.id]],
    ])(
      'shows the %s only their own world, and some of it',
      async (_who, society, institutionIds) => {
        for (const table of await tenantTables()) {
          const rows = await visible(table.name, { societyId: society.id, institutionIds });
          expect(
            rows.length,
            `${table.name} has no rows in this world: write its seed rows so the check is not vacuous`,
          ).toBeGreaterThan(0);
          for (const row of rows) {
            const owner = table.name === 'societies' ? row.id : row.society_id;
            expect({ table: table.name, society: owner }).toEqual({
              table: table.name,
              society: society.id,
            });
            if (table.hasInstitution && institutionIds.length > 0 && row.institution_id) {
              expect(institutionIds).toContain(row.institution_id);
            }
          }
        }
      },
    );

    it('shows a request that set no tenant nothing, from every table', async () => {
      for (const table of await tenantTables()) expect(await visible(table.name, {})).toEqual([]);
    });

    it('shows a tenant that is not a Society in the data nothing', async () => {
      for (const table of await tenantTables()) {
        expect(await visible(table.name, { societyId: missing })).toEqual([]);
      }
    });
  });

  describe('every tenant-scoped endpoint, called from each side', () => {
    it.each([
      ['ownerA', a1, 200],
      ['ownerA', a2, 200],
      ['ownerA', b1, 404],
      ['ownerB', a1, 404],
      ['ownerB', b1, 200],
      ['adminA1', a1, 200],
      ['adminA1', a2, 404],
      ['adminA1', b1, 404],
      ['adminA12', a1, 200],
      ['adminA12', a2, 200],
      ['adminA12', b1, 404],
      ['adminB1', a1, 404],
      ['adminB1', b1, 200],
    ] as const)('%s reading Institution %#: %s', async (key, institution, expected) => {
      const res = await get(`/v1/fixtures/tenant/institutions/${institution.id}`, key);
      expect(res.status).toBe(expected);
      if (expected === 200) expect(res.body.data).toMatchObject({ id: institution.id });
    });

    it.each([
      ['ownerA', socA, 200],
      ['ownerA', socB, 404],
      ['ownerB', socA, 404],
      ['adminA1', socA, 200],
      ['adminA1', socB, 404],
      ['adminB1', socA, 404],
    ] as const)('%s reading Society %#: %s', async (key, society, expected) => {
      expect((await get(`/v1/fixtures/tenant/societies/${society.id}`, key)).status).toBe(expected);
    });

    it('answers a foreign Institution exactly as it answers one that does not exist', async () => {
      const foreign = await get(`/v1/fixtures/tenant/institutions/${b1.id}`, 'ownerA');
      const absent = await get(`/v1/fixtures/tenant/institutions/${missing}`, 'ownerA');
      expect(foreign.status).toBe(404);
      expect(strip(foreign)).toEqual(strip(absent));
    });

    it("lets a write reach the caller's own Institution and no other, and leaves the other untouched", async () => {
      await rename(a1.id, 'ownerA', 'Renamed by A').expect(200);
      expect((await rename(b1.id, 'ownerA', 'Hijacked by A')).status).toBe(404);
      expect((await rename(a2.id, 'adminA1', 'Hijacked by A1 admin')).status).toBe(404);
      const names = await ownerDb
        .transaction()
        .execute(async (tx) => {
          await sql`select set_config('app.role_code', '1', true)`.execute(tx);
          return sql<{ id: string; name: string }>`select id, name from institutions`.execute(tx);
        })
        .then((result) => new Map(result.rows.map((row) => [row.id, row.name])));
      expect(names.get(a1.id)).toBe('Renamed by A');
      expect(names.get(a2.id)).toBe(a2.name);
      expect(names.get(b1.id)).toBe(b1.name);
      await rename(a1.id, 'ownerA', a1.name).expect(200);
    });

    it('answers 423 for a paused Institution and keeps the others in its Society open', async () => {
      await setInstitution(a2.id, 'paused');
      expect((await get(`/v1/fixtures/tenant/institutions/${a2.id}`, 'ownerA')).status).toBe(423);
      expect((await get(`/v1/fixtures/tenant/institutions/${a2.id}`, 'adminA12')).status).toBe(423);
      expect((await get(`/v1/fixtures/tenant/institutions/${a1.id}`, 'ownerA')).status).toBe(200);
    });

    it('answers 404 for a deactivated Institution', async () => {
      await setInstitution(a2.id, 'inactive');
      expect((await get(`/v1/fixtures/tenant/institutions/${a2.id}`, 'ownerA')).status).toBe(404);
      expect((await get(`/v1/fixtures/tenant/institutions/${a2.id}`, 'adminA12')).status).toBe(404);
    });

    it('stops an Institution Admin at once when the grant is revoked', async () => {
      await sql`update role_assignments set revoked_at = now() where user_id = ${personaByKey('IA-A1').id} and role_code = 3`.execute(
        ownerDb,
      );
      try {
        const res = await get(`/v1/fixtures/tenant/institutions/${a1.id}`, 'adminA1');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('SESSION_ENDED');
      } finally {
        await sql`update role_assignments set revoked_at = null, revoked_by = null, revoke_reason = null
          where user_id = ${personaByKey('IA-A1').id} and role_code = 3`.execute(ownerDb);
      }
    });
  });
});
