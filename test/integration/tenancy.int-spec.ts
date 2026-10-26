import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { TenantAccessGate } from '../../src/common/auth/tenant-access-gate.js';
import { RoleCode } from '../../src/common/auth/roles.js';
import { DatabaseService, type Tx, type TenantContext } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { institutions, personaByKey, societies } from '../../src/seeds/two-worlds.js';
import { superAdminToken } from '../support/admin-token.js';
import { FixtureModule } from '../support/fixture.module.js';
import { signInAs, signInMobile } from '../support/sessions.js';
import { clearLoginState } from '../support/login-state.js';
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
const missingId = '00000000-0000-7000-8000-00000000ffff';

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

const addInstitution = (societyId: string, code: string) => (tx: Tx) =>
  tx
    .insertInto('institutions')
    .values({ society_id: societyId, name: 'New', code, address_line_1: '1 Road' })
    .execute();

const edit = (id: string) => (tx: Tx) =>
  tx
    .updateTable('societies')
    .set({ description: 'Our schools' })
    .where('id', '=', id)
    .executeTakeFirst();

const pause = (table: 'societies' | 'institutions', id: string, by: string) => (tx: Tx) =>
  sql`
    update ${sql.table(table)} set access_paused_at = now(), access_paused_by = ${by},
      access_pause_reason = 'Dues unpaid' where id = ${id}
  `.execute(tx);
const resume = (table: 'societies' | 'institutions', id: string) => (tx: Tx) =>
  sql`
    update ${sql.table(table)} set access_paused_at = null, access_paused_by = null,
      access_pause_reason = null where id = ${id}
  `.execute(tx);

const accepted = (promise: Promise<unknown>) =>
  promise.catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== 'rollback') throw error;
  });

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

const names = (tenant: TenantContext, table: 'societies' | 'institutions') =>
  database
    .transaction(tenant, (tx) => tx.selectFrom(table).select('name').orderBy('name').execute())
    .then((rows) => rows.map((row) => row.name));

const setPause = (id: string, paused: boolean, table: 'societies' | 'institutions') =>
  ownerDb.transaction().execute(async (tx) => {
    await sql`select set_config('app.role_code', '1', true)`.execute(tx);
    await sql`
      update ${sql.table(table)} set
        access_paused_at = ${paused ? sql`now()` : null},
        access_paused_by = ${paused ? superAdmin.id : null},
        access_pause_reason = ${paused ? 'Dues unpaid' : null}
      where id = ${id}
    `.execute(tx);
  });

const insertInstitution = (societyId: string, code: string, extra: Record<string, unknown> = {}) =>
  inRolledBack(asSuperAdmin, (tx) =>
    tx
      .insertInto('institutions')
      .values({
        society_id: societyId,
        name: 'Scratch',
        code,
        address_line_1: '1 Road',
        ...extra,
      })
      .execute(),
  );

const grant = (society: string, institution: string | null) =>
  ownerDb.transaction().execute(async (tx) => {
    await sql`
      insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
      values (${owner.id}, 3, ${society}, ${institution}, gen_random_uuid())
    `.execute(tx);
    throw new Error('rollback');
  });

const adminToken = () => superAdminToken(t, ownerDb, superAdmin.id);

const call = (method: 'get' | 'post', path: string, bearer: string) =>
  request(t.app.getHttpServer())[method](path).set('Authorization', `Bearer ${bearer}`).send({});

describe('Societies and Institutions (DDD 9.3, 15.3)', () => {
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

  afterEach(async () => {
    for (const id of [societyA.id, societyB.id]) await setPause(id, false, 'societies');
    for (const { id } of [instA1, instA2, instB1]) await setPause(id, false, 'institutions');
  });

  describe('row-level security', () => {
    it('is enabled and forced on both tables', async () => {
      const { rows } = await sql<{ name: string; rls: boolean; forced: boolean }>`
        select relname as name, relrowsecurity as rls, relforcerowsecurity as forced
        from pg_class where relname in ('societies', 'institutions') and relkind = 'r'
        order by relname
      `.execute(ownerDb);
      expect(rows).toEqual([
        { name: 'institutions', rls: true, forced: true },
        { name: 'societies', rls: true, forced: true },
      ]);
    });

    it('shows a request with no tenant set no rows at all', async () => {
      expect(await names({}, 'societies')).toEqual([]);
      expect(await names({}, 'institutions')).toEqual([]);
    });

    it('shows a Society Owner their own Society and its Institutions, never the sibling world', async () => {
      expect(await names(asOwnerOf(societyA), 'societies')).toEqual([societyA.name]);
      expect(await names(asOwnerOf(societyA), 'institutions')).toEqual([instA1.name, instA2.name]);
      expect(await names(asOwnerOf(societyB), 'institutions')).toEqual([instB1.name]);
    });

    it('shows Super Admin every Society and Institution', async () => {
      expect(await names(asSuperAdmin, 'societies')).toEqual([societyA.name, societyB.name]);
      expect(await names(asSuperAdmin, 'institutions')).toEqual([
        instA1.name,
        instA2.name,
        instB1.name,
      ]);
    });

    it('does not let another Society read a row by its ID', async () => {
      const found = await database.transaction(asOwnerOf(societyA), (tx) =>
        tx.selectFrom('institutions').select('id').where('id', '=', instB1.id).executeTakeFirst(),
      );
      expect(found).toBeUndefined();
    });

    it('opens everything to role 1 only: an owner who claims another role still sees one Society', async () => {
      const claimed: TenantContext = {
        ...asOwnerOf(societyA),
        roleCode: RoleCode.InstitutionAdmin,
      };
      expect(await names(claimed, 'societies')).toEqual([societyA.name]);
    });

    describe('writing', () => {
      it('lets an owner add an Institution to their own Society only', async () => {
        await inRolledBack(asOwnerOf(societyA), addInstitution(societyA.id, 'A3'));
        await expect(
          inRolledBack(asOwnerOf(societyA), addInstitution(societyB.id, 'X1')),
        ).rejects.toThrow(/row-level security/);
      });

      it('does not let an owner move an Institution into another Society', async () => {
        await expect(
          inRolledBack(asOwnerOf(societyA), (tx) =>
            tx
              .updateTable('institutions')
              .set({ society_id: societyB.id })
              .where('id', '=', instA1.id)
              .execute(),
          ),
        ).rejects.toThrow(/row-level security/);
      });

      it("changes nothing when an owner updates another Society's Institution", async () => {
        const updated = await inRolledBack(asOwnerOf(societyA), (tx) =>
          tx
            .updateTable('institutions')
            .set({ name: 'Hijacked' })
            .where('id', '=', instB1.id)
            .executeTakeFirst(),
        );
        expect(updated.numUpdatedRows).toBe(0n);
      });

      it('lets only Super Admin create a Society', async () => {
        const values = { name: 'Third', code: 'C' };
        await expect(
          inRolledBack(asOwnerOf(societyA), (tx) =>
            tx.insertInto('societies').values(values).execute(),
          ),
        ).rejects.toThrow(/row-level security/);
        await inRolledBack(asSuperAdmin, (tx) =>
          tx.insertInto('societies').values(values).execute(),
        );
      });

      it('lets an owner edit their own Society profile and not another', async () => {
        expect((await inRolledBack(asOwnerOf(societyA), edit(societyA.id))).numUpdatedRows).toBe(
          1n,
        );
        expect((await inRolledBack(asOwnerOf(societyA), edit(societyB.id))).numUpdatedRows).toBe(
          0n,
        );
      });

      it('raises the version on every change', async () => {
        const versions = await inRolledBack(asSuperAdmin, async (tx) => {
          const read = () =>
            tx
              .selectFrom('societies')
              .select('version')
              .where('id', '=', societyA.id)
              .executeTakeFirstOrThrow()
              .then((row) => row.version);
          const before = await read();
          await tx
            .updateTable('societies')
            .set({ description: 'One' })
            .where('id', '=', societyA.id)
            .execute();
          return { before, after: await read() };
        });
        expect(versions.after).toBe(versions.before + 1);
      });

      it('cannot delete a Society or an Institution, not even as Super Admin: they are deactivated', async () => {
        await expect(
          inRolledBack(asSuperAdmin, (tx) => tx.deleteFrom('societies').execute()),
        ).rejects.toThrow(/permission denied/);
        await expect(
          inRolledBack(asSuperAdmin, (tx) => tx.deleteFrom('institutions').execute()),
        ).rejects.toThrow(/permission denied/);
      });
    });
  });

  describe('who may pause or resume access (PRD 9.4)', () => {
    it('lets Super Admin pause a Society and an Institution', async () => {
      await inRolledBack(asSuperAdmin, pause('societies', societyA.id, superAdmin.id));
      await inRolledBack(asSuperAdmin, pause('institutions', instA1.id, superAdmin.id));
    });

    it('does not let an owner pause their own Society or Institution, or lift a pause', async () => {
      for (const [table, id] of [
        ['societies', societyA.id],
        ['institutions', instA1.id],
      ] as const) {
        await expect(inRolledBack(asOwnerOf(societyA), pause(table, id, owner.id))).rejects.toThrow(
          /Only Super Admin may change/,
        );
      }
      await setPause(societyA.id, true, 'societies');
      await setPause(instA1.id, true, 'institutions');
      for (const [table, id] of [
        ['societies', societyA.id],
        ['institutions', instA1.id],
      ] as const) {
        await expect(inRolledBack(asOwnerOf(societyA), resume(table, id))).rejects.toThrow(
          /Only Super Admin may change/,
        );
      }
    });

    it('does not let an owner change the Society code, and lets Super Admin', async () => {
      const recode = (tx: Tx) =>
        sql`update societies set code = 'ZZ' where id = ${societyA.id}`.execute(tx);
      await expect(inRolledBack(asOwnerOf(societyA), recode)).rejects.toThrow(
        /Only Super Admin may change/,
      );
      await inRolledBack(asSuperAdmin, recode);
    });

    it('does not let an owner deactivate or reactivate their Society, and lets Super Admin', async () => {
      const deactivate = (tx: Tx) =>
        sql`update societies set status = 0 where id = ${societyA.id}`.execute(tx);
      await expect(inRolledBack(asOwnerOf(societyA), deactivate)).rejects.toThrow(
        /Only Super Admin may change/,
      );
      await inRolledBack(asSuperAdmin, deactivate);
    });

    it('lets an owner deactivate an Institution of their Society (PRD 7.1)', async () => {
      const done = await inRolledBack(asOwnerOf(societyA), (tx) =>
        tx
          .updateTable('institutions')
          .set({ status: 0 })
          .where('id', '=', instA2.id)
          .executeTakeFirst(),
      );
      expect(done.numUpdatedRows).toBe(1n);
    });

    it('lets an owner change the code and name of an Institution', async () => {
      const done = await inRolledBack(asOwnerOf(societyA), (tx) =>
        tx
          .updateTable('institutions')
          .set({ code: 'NEWCODE', name: 'Renamed' })
          .where('id', '=', instA1.id)
          .executeTakeFirst(),
      );
      expect(done.numUpdatedRows).toBe(1n);
    });

    it('needs a person, a time and a reason together, or none', async () => {
      await expect(
        inRolledBack(asSuperAdmin, (tx) =>
          sql`update societies set access_paused_at = now() where id = ${societyA.id}`.execute(tx),
        ),
      ).rejects.toThrow(/ck_societies_pause/);
      await expect(
        inRolledBack(asSuperAdmin, (tx) =>
          sql`update institutions set access_pause_reason = 'x' where id = ${instA1.id}`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/ck_institutions_pause/);
    });
  });

  describe('constraints', () => {
    it('keeps an Institution code unique within its Society, ignoring case, and free across Societies', async () => {
      await expect(insertInstitution(societyA.id, 'a1')).rejects.toThrow(
        /uq_institutions_society_code/,
      );
      await insertInstitution(societyB.id, 'a1');
    });

    it('keeps a Society code unique across the platform', async () => {
      await expect(
        inRolledBack(asSuperAdmin, (tx) =>
          tx.insertInto('societies').values({ name: 'Copy', code: societyA.key }).execute(),
        ),
      ).rejects.toThrow(/uq_societies_code/);
    });

    it.each([
      ['a GSTIN of the wrong shape', { gstin: '123' }, /ck_institutions_gstin/],
      ['a board outside the list of six', { board_code: 7 }, /ck_institutions_board/],
      ['a latitude beyond the pole', { latitude: '90.5' }, /ck_institutions_latitude/],
      ['a longitude beyond the date line', { longitude: '-181' }, /ck_institutions_longitude/],
      ['a country code with no number', { country_code: '91' }, /ck_institutions_phone_pair/],
      ['an email in capitals', { email: 'Head@School.test' }, /ck_institutions_email/],
      ['a blank address', { address_line_1: '  ' }, /ck_institutions_address/],
      ['a status other than 0 or 1', { status: 2 }, /ck_institutions_status/],
    ])('refuses %s', async (_label, extra, message) => {
      await expect(insertInstitution(societyA.id, 'NEW', extra)).rejects.toThrow(message);
    });

    it('accepts a well-formed GSTIN, board and location', async () => {
      await insertInstitution(societyA.id, 'GOOD', {
        gstin: '29ABCDE1234F1Z5',
        board_code: 1,
        latitude: '12.971599',
        longitude: '77.594566',
        country_code: '91',
        phone_number: '9876543210',
      });
    });

    it('refuses a Society website without http(s) and an email in capitals', async () => {
      await expect(
        inRolledBack(asSuperAdmin, (tx) =>
          tx.insertInto('societies').values({ name: 'X', code: 'X', website: 'ftp://x' }).execute(),
        ),
      ).rejects.toThrow(/ck_societies_website/);
      await expect(
        inRolledBack(asSuperAdmin, (tx) =>
          tx.insertInto('societies').values({ name: 'X', code: 'X', email: 'A@B.test' }).execute(),
        ),
      ).rejects.toThrow(/ck_societies_email/);
    });

    it('refuses an Institution of a Society that does not exist', async () => {
      await expect(insertInstitution(missingId, 'X')).rejects.toThrow(
        /institutions_society_id_fkey/,
      );
    });
  });

  describe('grants point at real tenants', () => {
    it('refuses a grant that names a Society that does not exist', async () => {
      await expect(grant(missingId, instA1.id)).rejects.toThrow(/fk_role_assignments/);
    });

    it('refuses a grant to an Institution that belongs to a different Society', async () => {
      await expect(grant(societyA.id, instB1.id)).rejects.toThrow(
        /fk_role_assignments_institution/,
      );
    });

    it('accepts a grant to an Institution of that Society', async () => {
      await accepted(grant(societyA.id, instA1.id));
    });

    it('refuses a session acting as role 2, 3 or 4 with no Society, and allows roles 1 and 5', async () => {
      const session = (role: number) =>
        sql`insert into auth_sessions (user_id, client_type, active_role_code, idle_expires_at, absolute_expires_at)
          values (${owner.id}, 1, ${role}, now() + interval '1 hour', now() + interval '1 hour')`.execute(
          ownerDb,
        );
      for (const role of [2, 3, 4]) {
        await expect(session(role)).rejects.toThrow(/ck_auth_sessions_society/);
      }
      for (const role of [1, 5]) {
        await session(role);
      }
      await sql`delete from auth_sessions where user_id = ${owner.id}`.execute(ownerDb);
    });

    it('refuses a session whose active Society does not exist', async () => {
      await expect(
        sql`insert into auth_sessions (user_id, client_type, active_society_id, idle_expires_at, absolute_expires_at)
          values (${owner.id}, 1, ${missingId}, now() + interval '1 hour', now() + interval '1 hour')`.execute(
          ownerDb,
        ),
      ).rejects.toThrow(/fk_auth_sessions_society/);
    });
  });

  describe('the pause check', () => {
    it('reports a Society paused while it is, and open again after the resume', async () => {
      const gate = t.app.get(TenantAccessGate);
      expect(await gate.isPaused(caller(societyA))).toBe(false);
      await setPause(societyA.id, true, 'societies');
      expect(await gate.isPaused(caller(societyA))).toBe(true);
      expect(await gate.isPaused(caller(societyB))).toBe(false);
      await setPause(societyA.id, false, 'societies');
      expect(await gate.isPaused(caller(societyA))).toBe(false);
    });

    it('treats a caller with no Society as not paused, and a Society nobody can see as paused', async () => {
      const gate = t.app.get(TenantAccessGate);
      expect(await gate.isPaused(caller(null, 1))).toBe(false);
      expect(await gate.isPaused(caller({ id: missingId }))).toBe(true);
    });
  });

  describe('over HTTP, with a real session', () => {
    beforeEach(async () => {
      await clearLoginState(ownerDb);
    });

    it('stops a paused Society on its next call, keeps sign-in, profile and sign-out, and resumes', async () => {
      const token = await signInAs(t, owner.email, { roleCode: 2, societyId: societyA.id });
      await call('post', '/v1/fixtures/owner-write', token).expect(200);

      await setPause(societyA.id, true, 'societies');
      const refused = await call('post', '/v1/fixtures/owner-write', token);
      expect(refused.status).toBe(423);
      expect(refused.body).toMatchObject({ success: false, code: 'ACCESS_PAUSED' });
      await call('get', '/v1/me', token).expect(200);
      await call('get', '/v1/fixtures/owner-read-when-paused', token).expect(200);

      await setPause(societyA.id, false, 'societies');
      await call('post', '/v1/fixtures/owner-write', token).expect(200);
      await call('post', '/v1/auth/logout', token).expect(200);
    });

    it('lets a paused person sign in, and never stops Super Admin', async () => {
      await setPause(societyA.id, true, 'societies');
      await call('get', '/v1/me', (await signInMobile(t, owner.email)).accessToken).expect(200);
      await call('get', '/v1/fixtures/admin-only', await adminToken()).expect(200);
    });
  });
});
