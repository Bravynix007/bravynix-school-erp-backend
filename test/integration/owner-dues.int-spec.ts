import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { BackgroundMailer } from '../../src/platform/identity/index.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { setBlock, clearBlocks } from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

/** A financial year no other test uses, so the invoice counter starts from 1 here. */
const TEST_DAY = '2032-06-01T04:30:00.000Z';
const TEST_YEAR = 'FY2032-33';

const ownerDuesPath = '/v1/platform-dues';

interface OwnerDues {
  banner: { totalDueAmount: string; hasOpenDues: boolean };
  dues: DueLine[];
}

/** The `data` of an answer, as the shape the test expects. */
const dataOf = <T>(res: { body: { data: unknown } }) => res.body.data as T;

interface DueLine {
  id: string;
  invoiceNo: string;
  totalAmount: string;
  dueStatus: number;
}

describe('BIL-01 and BIL-02 the Owner’s view of platform dues (PRD 9.3, API design 10.22)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const owners = new Map<string, SignedInPerson>();

  const ownerOf = async (societyId: string) => {
    let owner = owners.get(societyId);
    if (!owner) {
      owner = await fixtures.owner(societyId);
      owners.set(societyId, owner);
    }
    return owner;
  };

  const society = async () => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    expect(res.status).toBe(201);
    societies.push(res.body.data.id);
    return res.body.data.id;
  };

  /** A Society with an Owner and one Institution charged 50.00 from 1 April 2026. */
  const world = async (name = 'Green Valley School') => {
    const societyId = await society();
    const owner = await ownerOf(societyId);
    const inst = await api('post', '/v1/institutions', owner.token, {
      name,
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
    });
    expect(inst.status).toBe(201);
    const institutionId = inst.body.data.id;
    const rate = await api(
      'post',
      `/v1/platform/institutions/${institutionId}/price-rates`,
      admin,
      {
        ratePerStudentAmount: '50.00',
        effectiveFromDate: '2026-04-01',
      },
    );
    expect(rate.status).toBe(201);
    return { societyId, institutionId, owner };
  };

  const raised = async (institutionId: string, overrides: object = {}) => {
    const res = await request(t.app.getHttpServer())
      .post('/v1/platform/dues')
      .set('Authorization', `Bearer ${admin}`)
      .set('Idempotency-Key', newId())
      .send({
        institutionId,
        periodStartDate: '2026-04-01',
        periodEndDate: '2027-03-31',
        studentCount: 300,
        studentCountNote: 'Internal count note',
        ...overrides,
      });
    expect(res.status).toBe(201);
    return res.body.data as DueLine;
  };

  const pay = async (id: string) => {
    const res = await api('post', `/v1/platform/dues/${id}/mark-paid`, admin, {
      version: 1,
      paidDate: '2026-05-10',
      paymentMode: 2,
      paymentReference: 'UTR 4821',
    });
    expect(res.status).toBe(200);
  };

  const cancel = async (id: string) => {
    const res = await api('post', `/v1/platform/dues/${id}/cancel`, admin, {
      version: 1,
      reason: 'Raised twice, internal reason',
    });
    expect(res.status).toBe(200);
  };

  const readDues = (tenant: object) =>
    database.transaction(tenant, (tx) =>
      sql<{ id: string }>`select id from platform_dues`.execute(tx),
    );

  const clearState = () =>
    ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      await sql`delete from number_sequences where sequence_type = 3 and period_key = ${TEST_YEAR}`.execute(
        tx,
      );
      await sql`delete from idempotency_keys`.execute(tx);
    });

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
    fixtures = new PlatformFixtures(t, ownerDb);
    api = apiCaller(t);
  });

  afterAll(async () => {
    await clearState();
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    await clearState();
    t.clock.set(TEST_DAY);
    t.email.clear();
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    await sql`update auth_sessions set idle_expires_at = '2040-01-01', absolute_expires_at = '2040-01-01'
      where user_id = ${superAdmin.id}`.execute(ownerDb);
  });

  afterEach(async () => {
    await t.app.get(BackgroundMailer).flush();
    await clearBlocks(ownerDb);
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    owners.clear();
    await fixtures.cleanup();
  });

  describe('who may call', () => {
    it('keeps both endpoints from Super Admin and Institution Admins, and from callers with no token', async () => {
      const { societyId, institutionId } = await world();
      const due = await raised(institutionId);
      const adminOf = await fixtures.institutionAdmin(societyId, [institutionId]);

      for (const token of [admin, adminOf.token]) {
        for (const path of [ownerDuesPath, `${ownerDuesPath}/${due.id}`]) {
          const res = await api('get', path, token);
          expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
        }
      }
      const http = request(t.app.getHttpServer());
      expect((await http.get(ownerDuesPath)).status).toBe(401);
      expect((await http.get(`${ownerDuesPath}/${due.id}`)).status).toBe(401);
    });

    it('is read only: nothing else is served on these paths', async () => {
      const { owner, institutionId } = await world();
      const due = await raised(institutionId);
      for (const method of ['post', 'patch', 'delete'] as const) {
        const res = await api(method, `${ownerDuesPath}/${due.id}`, owner.token, {});
        expect(res.status).toBe(404);
      }
      expect((await api('post', ownerDuesPath, owner.token, {})).status).toBe(404);
    });
  });

  describe('BIL-01 the banner and the list', () => {
    it('shows "all paid" with no dues at all', async () => {
      const { owner } = await world();
      const res = await api('get', ownerDuesPath, owner.token);
      expect([res.status, res.body.code]).toEqual([200, 'OK']);
      expect(res.body.data).toEqual({
        banner: { totalDueAmount: '0.00', hasOpenDues: false },
        dues: [],
      });
      expect(res.body.meta).toBeNull();
    });

    it('totals the dues still Due, lists every due newest first, and gives each line only what an Owner needs', async () => {
      const { institutionId, owner } = await world();
      const first = await raised(institutionId);
      const second = await raised(institutionId, {
        studentCount: 280,
        adjustmentAmount: '-100.00',
        adjustmentNote: 'Goodwill',
        dueDate: '2026-11-15',
      });
      const third = await raised(institutionId, { studentCount: 10 });
      await pay(first.id);
      await cancel(third.id);

      const res = await api('get', ownerDuesPath, owner.token);
      expect(res.status).toBe(200);
      // 280 x 50.00 - 100.00 is the only due still Due; the Paid and the Cancelled are not counted.
      expect(dataOf<OwnerDues>(res).banner).toEqual({
        totalDueAmount: '13900.00',
        hasOpenDues: true,
      });
      expect(dataOf<OwnerDues>(res).dues.map((line) => line.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
      expect(res.body.data.dues).toEqual([
        expect.objectContaining({ id: third.id, dueStatus: 0, totalAmount: '500.00' }),
        {
          id: second.id,
          invoiceNo: second.invoiceNo,
          institution: { id: institutionId, name: 'Green Valley School' },
          periodStartDate: '2026-04-01',
          periodEndDate: '2027-03-31',
          totalAmount: '13900.00',
          dueStatus: 1,
          dueDate: '2026-11-15',
          paidDate: null,
          paymentMode: null,
          paymentReference: null,
          invoiceFile: null,
        },
        expect.objectContaining({
          id: first.id,
          dueStatus: 2,
          paidDate: '2026-05-10',
          paymentMode: 2,
          paymentReference: 'UTR 4821',
        }),
      ]);
      const text = JSON.stringify(res.body);
      for (const hidden of [
        'Internal count note',
        'internal reason',
        'cancel',
        'createdBy',
        'version',
      ]) {
        expect(text).not.toContain(hidden);
      }
    });

    it('reads "all paid" once the last open due is paid or cancelled', async () => {
      const { institutionId, owner } = await world();
      const one = await raised(institutionId);
      const two = await raised(institutionId);
      expect(dataOf<OwnerDues>(await api('get', ownerDuesPath, owner.token)).banner).toEqual({
        totalDueAmount: '30000.00',
        hasOpenDues: true,
      });
      await pay(one.id);
      await cancel(two.id);
      expect(dataOf<OwnerDues>(await api('get', ownerDuesPath, owner.token)).banner).toEqual({
        totalDueAmount: '0.00',
        hasOpenDues: false,
      });
    });

    it('follows a change at once: an edited amount changes the total', async () => {
      const { institutionId, owner } = await world();
      const due = await raised(institutionId);
      const edit = await api('patch', `/v1/platform/dues/${due.id}`, admin, {
        version: 1,
        studentCount: 100,
      });
      expect(edit.status).toBe(200);
      expect(
        dataOf<OwnerDues>(await api('get', ownerDuesPath, owner.token)).banner.totalDueAmount,
      ).toBe('5000.00');
    });

    it('shows an Owner only their own Society, even when another Society has dues', async () => {
      const one = await world();
      const two = await world('Blue Hill School');
      const mine = await raised(one.institutionId);
      const theirs = await raised(two.institutionId, { studentCount: 20 });

      const first = await api('get', ownerDuesPath, one.owner.token);
      expect(dataOf<OwnerDues>(first).dues.map((line) => line.id)).toEqual([mine.id]);
      expect(dataOf<OwnerDues>(first).banner.totalDueAmount).toBe('15000.00');
      const second = await api('get', ownerDuesPath, two.owner.token);
      expect(dataOf<OwnerDues>(second).dues.map((line) => line.id)).toEqual([theirs.id]);
      expect(dataOf<OwnerDues>(second).banner.totalDueAmount).toBe('1000.00');
    });

    it('works while the Society’s Owners are blocked, when other Owner calls are refused with 423', async () => {
      const { societyId, institutionId, owner } = await world();
      const due = await raised(institutionId);
      await setBlock(ownerDb, societyId, null, 1, true);

      const refused = await api('get', '/v1/institutions', owner.token);
      expect([refused.status, refused.body.code]).toEqual([423, 'SECTION_BLOCKED']);
      expect((await api('get', ownerDuesPath, owner.token)).status).toBe(200);
      expect((await api('get', `${ownerDuesPath}/${due.id}`, owner.token)).status).toBe(200);
    });

    it('still names the Institution after the Owner deactivates it', async () => {
      const { institutionId, owner } = await world();
      await raised(institutionId);
      expect((await api('delete', `/v1/institutions/${institutionId}`, owner.token)).status).toBe(
        200,
      );
      const res = await api('get', ownerDuesPath, owner.token);
      expect(dataOf<OwnerDues>(res).dues).toEqual([
        expect.objectContaining({
          institution: { id: institutionId, name: 'Green Valley School' },
        }),
      ]);
    });
  });

  describe('BIL-02 one due', () => {
    it('gives the charge in full: count, rate, base, adjustment and its note, without BravyNix’s own notes', async () => {
      const { institutionId, owner } = await world();
      const due = await raised(institutionId, {
        adjustmentAmount: '-500.00',
        adjustmentNote: 'Opening discount',
        dueDate: '2026-05-15',
      });
      await pay(due.id);

      const res = await api('get', `${ownerDuesPath}/${due.id}`, owner.token);
      expect([res.status, res.body.code]).toEqual([200, 'OK']);
      expect(res.body.data).toEqual({
        id: due.id,
        invoiceNo: due.invoiceNo,
        institution: { id: institutionId, name: 'Green Valley School' },
        periodStartDate: '2026-04-01',
        periodEndDate: '2027-03-31',
        studentCount: 300,
        ratePerStudentAmount: '50.00',
        baseAmount: '15000.00',
        adjustmentAmount: '-500.00',
        adjustmentNote: 'Opening discount',
        totalAmount: '14500.00',
        dueStatus: 2,
        dueDate: '2026-05-15',
        paidDate: '2026-05-10',
        paymentMode: 2,
        paymentReference: 'UTR 4821',
        invoiceFile: null,
      });
    });

    it('answers 404 for a due of another Society, an unknown due and an ID that is not a UUID', async () => {
      const one = await world();
      const two = await world('Blue Hill School');
      const theirs = await raised(two.institutionId);
      for (const id of [theirs.id, missing, 'x']) {
        const res = await api('get', `${ownerDuesPath}/${id}`, one.owner.token);
        expect([res.status, res.body.code]).toEqual([404, 'NOT_FOUND']);
      }
    });
  });

  describe('the table', () => {
    it('shows an Owner their own Society’s dues only; an Admin, another Society’s Owner and a request with no tenant none', async () => {
      const one = await world();
      const two = await world('Blue Hill School');
      const due = await raised(one.institutionId);
      await raised(two.institutionId);

      expect((await readDues({ societyId: one.societyId, roleCode: 2 })).rows).toEqual([
        { id: due.id },
      ]);
      expect(
        (
          await readDues({
            societyId: one.societyId,
            roleCode: 3,
            institutionIds: [one.institutionId],
          })
        ).rows,
      ).toEqual([]);
      expect((await readDues({ societyId: missing, roleCode: 2 })).rows).toEqual([]);
      expect((await readDues({})).rows).toEqual([]);
    });

    it('still lets only Super Admin write: an Owner can neither insert, change nor delete a due', async () => {
      const { societyId, institutionId } = await world();
      const due = await raised(institutionId);
      const owner = { societyId, roleCode: 2, personId: superAdmin.id };

      for (const statement of [
        sql`update platform_dues set due_date = '2031-01-01'`,
        sql`update platform_dues set due_date = '2031-01-01' where id = ${due.id}`,
      ]) {
        const result = await database.transaction(owner, (tx) => statement.execute(tx));
        expect(result.numAffectedRows).toBe(0n);
      }
      await expect(
        database.transaction({ ...owner, institutionIds: [institutionId] }, (tx) =>
          sql`insert into platform_dues (society_id, institution_id, invoice_no, period_start_date,
            period_end_date, student_count_auto, student_count, student_count_note, price_rate_id,
            rate_per_student_amount, base_amount, total_amount, created_by)
            select society_id, institution_id, 'OWN/1', period_start_date, period_end_date,
              student_count_auto, student_count, student_count_note, price_rate_id,
              rate_per_student_amount, base_amount, total_amount, created_by
            from platform_dues`.execute(tx),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        database.transaction(owner, (tx) =>
          sql`delete from platform_dues where id = ${due.id}`.execute(tx),
        ),
      ).rejects.toThrow(/permission denied/);
      expect((await api('get', `/v1/platform/dues/${due.id}`, admin)).body.data).toMatchObject({
        dueDate: null,
        version: 1,
      });
    });
  });
});
