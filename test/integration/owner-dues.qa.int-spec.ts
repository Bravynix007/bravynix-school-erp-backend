import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { BackgroundMailer } from '../../src/platform/identity/index.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { signInAs } from '../support/sessions.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { clearBlocks } from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');

/** A financial year no other test uses, so the invoice counter starts from 1 here. */
const TEST_DAY = '2036-06-01T04:30:00.000Z';
const TEST_YEAR = 'FY2036-37';

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

const asOwner = (personId: string, societyId: string) => ({ personId, societyId, roleCode: 2 });

describe('QA: BIL-01 and BIL-02 the Owner view, adversarial (PRD 9.3, API design 10.22)', () => {
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

  /** How many dues a tenant reads. */
  const count = async (tenant: object) => (await readDues(tenant)).rows.length;

  const extras: string[] = [];
  afterEach(async () => {
    await clearLoginState(ownerDb);
    for (const person of extras.splice(0)) {
      await sql`delete from role_assignments where user_id = ${person}`.execute(ownerDb);
      await sql`delete from users where id = ${person}`.execute(ownerDb);
    }
  });

  /** A person who is Owner (seat 2) of every Society named. */
  const ownerOfMany = async (societyIds: string[]) => {
    const person = newId();
    const email = `${person}@two-worlds.test`;
    extras.push(person);
    await sql`insert into users (id, email) values (${person}, ${email})`.execute(ownerDb);
    for (const societyId of societyIds) {
      await sql`insert into role_assignments (user_id, role_code, society_id, seat_no)
        values (${person}, 2, ${societyId}, 2)`.execute(ownerDb);
    }
    return { person, email };
  };

  const editDue = async (id: string, body: object, version = 1) => {
    const res = await api('patch', `/v1/platform/dues/${id}`, admin, { version, ...body });
    expect(res.status).toBe(200);
    return res.body.data;
  };

  const ownerList = async (token: string) => {
    const res = await api('get', ownerDuesPath, token);
    expect(res.status).toBe(200);
    return dataOf<OwnerDues>(res);
  };

  const LINE_KEYS = [
    'dueDate',
    'dueStatus',
    'id',
    'institution',
    'invoiceFile',
    'invoiceNo',
    'paidDate',
    'paymentMode',
    'paymentReference',
    'periodEndDate',
    'periodStartDate',
    'totalAmount',
  ];
  const DETAIL_KEYS = [
    ...LINE_KEYS,
    'adjustmentAmount',
    'adjustmentNote',
    'baseAmount',
    'ratePerStudentAmount',
    'studentCount',
  ].toSorted();

  describe('Q1 an Owner of two Societies', () => {
    it('sees only the Society of the context chosen, and a due of the other is 404 there', async () => {
      const a = await world('School A');
      const b = await world('School B');
      const dueA = await raised(a.institutionId);
      const dueB = await raised(b.institutionId);
      const both = await ownerOfMany([a.societyId, b.societyId]);
      const inA = await signInAs(t, both.email, { roleCode: 2, societyId: a.societyId });
      const inB = await signInAs(t, both.email, { roleCode: 2, societyId: b.societyId });

      expect((await ownerList(inA)).dues.map((d) => d.id)).toEqual([dueA.id]);
      expect((await ownerList(inB)).dues.map((d) => d.id)).toEqual([dueB.id]);
      expect((await api('get', `${ownerDuesPath}/${dueB.id}`, inA)).status).toBe(404);
      expect((await api('get', `${ownerDuesPath}/${dueA.id}`, inB)).status).toBe(404);
      expect((await api('get', `${ownerDuesPath}/${dueA.id}`, inA)).status).toBe(200);
    });

    it('loses the view of a Society at once when that Owner grant is revoked', async () => {
      const a = await world();
      const due = await raised(a.institutionId);
      const one = await ownerOfMany([a.societyId]);
      const token = await signInAs(t, one.email, { roleCode: 2, societyId: a.societyId });
      expect((await api('get', `${ownerDuesPath}/${due.id}`, token)).status).toBe(200);
      await sql`update role_assignments set revoked_at = now() where user_id = ${one.person}`.execute(
        ownerDb,
      );
      const after = await api('get', ownerDuesPath, token);
      const detail = await api('get', `${ownerDuesPath}/${due.id}`, token);
      expect([401, 403]).toContain(after.status);
      expect([401, 403, 404]).toContain(detail.status);
    });
  });

  describe('Q2 IDs', () => {
    it('never answers 500 for odd IDs, and an upper-case copy of the Owner’s own ID is no way into another Society', async () => {
      const a = await world();
      const b = await world();
      const own = await raised(a.institutionId);
      const other = await raised(b.institutionId);
      for (const id of [
        other.id.toUpperCase(),
        `{${other.id}}`,
        `${other.id} `,
        `${other.id}%00`,
        '00000000-0000-0000-0000-000000000000',
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        "1' or '1'='1",
        '..%2F..%2Fplatform%2Fdues',
        'x'.repeat(2000),
      ]) {
        const res = await api('get', `${ownerDuesPath}/${encodeURI(id)}`, a.owner.token);
        expect([id.slice(0, 40), res.status]).toEqual([id.slice(0, 40), 404]);
      }
      const upper = await api('get', `${ownerDuesPath}/${own.id.toUpperCase()}`, a.owner.token);
      expect([200, 404]).toContain(upper.status);
    });

    it('ignores query parameters that try to widen the list', async () => {
      const a = await world();
      const b = await world();
      const own = await raised(a.institutionId);
      await raised(b.institutionId);
      for (const query of [
        `societyId=${b.societyId}`,
        `institutionId=${b.institutionId}`,
        'limit=1000',
        'dueStatus=0&dueStatus=1&dueStatus=2',
      ]) {
        const res = await api('get', `${ownerDuesPath}?${query}`, a.owner.token);
        expect(res.status).toBeLessThan(500);
        if (res.status === 200) {
          expect(dataOf<OwnerDues>(res).dues.map((d) => d.id)).toEqual([own.id]);
        }
      }
    });
  });

  describe('Q3 the banner', () => {
    it('adds three dues at the column maximum exactly, past what one due can hold', async () => {
      const { institutionId, owner } = await world();
      const rate = await api(
        'post',
        `/v1/platform/institutions/${institutionId}/price-rates`,
        admin,
        {
          ratePerStudentAmount: '99999999.99',
          effectiveFromDate: '2027-01-01',
        },
      );
      expect(rate.status).toBe(201);
      for (let i = 0; i < 3; i += 1) {
        await raised(institutionId, {
          periodStartDate: '2027-01-01',
          studentCount: 100,
          adjustmentAmount: '0.99',
          adjustmentNote: 'Rounding',
        });
      }
      expect((await ownerList(owner.token)).banner).toEqual({
        totalDueAmount: '29999999999.97',
        hasOpenDues: true,
      });
    });

    it('agrees with the list after a mix of pay, cancel and edit', async () => {
      const { institutionId, owner } = await world();
      const a = await raised(institutionId);
      const b = await raised(institutionId, { studentCount: 100 });
      const c = await raised(institutionId, { studentCount: 7 });
      const d = await raised(institutionId, { studentCount: 11 });
      await pay(a.id);
      await cancel(b.id);
      await editDue(c.id, { adjustmentAmount: '-0.50', adjustmentNote: 'Discount' });
      const view = await ownerList(owner.token);
      const sum = view.dues
        .filter((line) => line.dueStatus === 1)
        .reduce((cents, line) => cents + Math.round(Number(line.totalAmount) * 100), 0);
      expect(view.banner.totalDueAmount).toBe((sum / 100).toFixed(2));
      expect(view.banner.totalDueAmount).toBe('899.50');
      expect(view.dues.map((line) => [line.id, line.dueStatus])).toEqual([
        [d.id, 1],
        [c.id, 1],
        [b.id, 0],
        [a.id, 2],
      ]);
    });

    it('reads all paid for an open due of 0.00, though the due is listed (BravyNix, 1 Nov)', async () => {
      const { institutionId, owner } = await world();
      await raised(institutionId, { studentCount: 0, studentCountNote: null });
      const { banner, dues } = await ownerList(owner.token);
      expect(banner).toEqual({ totalDueAmount: '0.00', hasOpenDues: false });
      expect(dues).toHaveLength(1);
    });
  });

  describe('Q4 nothing internal leaks', () => {
    it('gives each line and the detail exactly the documented fields, and none of BravyNix’s notes or stamps appear anywhere', async () => {
      const { institutionId, owner } = await world();
      const due = await raised(institutionId, {
        studentCountNote: 'QA-SECRET-COUNT-NOTE',
        adjustmentAmount: '-10.00',
        adjustmentNote: 'Loyalty discount',
      });
      const cancelled = await raised(institutionId);
      const reason = await api('post', `/v1/platform/dues/${cancelled.id}/cancel`, admin, {
        version: 1,
        reason: 'QA-SECRET-CANCEL-REASON',
      });
      expect(reason.status).toBe(200);
      const list = await api('get', ownerDuesPath, owner.token);
      const detail = await api('get', `${ownerDuesPath}/${due.id}`, owner.token);
      const cancelledDetail = await api('get', `${ownerDuesPath}/${cancelled.id}`, owner.token);
      for (const line of dataOf<OwnerDues>(list).dues) {
        expect(Object.keys(line).toSorted()).toEqual(LINE_KEYS);
      }
      expect(Object.keys(detail.body.data).toSorted()).toEqual(DETAIL_KEYS);
      expect(Object.keys(cancelledDetail.body.data).toSorted()).toEqual(DETAIL_KEYS);
      const everything = JSON.stringify([list.body, detail.body, cancelledDetail.body]);
      for (const secret of [
        'QA-SECRET-COUNT-NOTE',
        'QA-SECRET-CANCEL-REASON',
        superAdmin.id,
        'priceRateId',
        'studentCountAuto',
        'createdBy',
        'updatedBy',
        'cancelledBy',
        'version',
        'societyName',
      ]) {
        expect([secret, everything.includes(secret)]).toEqual([secret, false]);
      }
      expect(detail.body.data.adjustmentNote).toBe('Loyalty discount');
    });
  });

  describe('Q5 the table', () => {
    it('an Owner tenant cannot change a due by any route the table offers, not even its own Society’s', async () => {
      const { societyId, institutionId, owner } = await world();
      const due = await raised(institutionId);
      const tenant = asOwner(owner.person, societyId);
      for (const statement of [
        sql`update platform_dues set due_date = '2036-07-01' where id = ${due.id}`,
        sql`update platform_dues set due_status = 0, cancelled_at = now(), cancelled_by = ${owner.person}, cancel_reason = 'mine now' where id = ${due.id}`,
        sql`delete from platform_dues where id = ${due.id}`,
        sql`select id from platform_dues where id = ${due.id} for update`,
      ]) {
        const outcome = await database
          .transaction(tenant, (tx) => statement.execute(tx))
          .then(
            (res) => `ok ${String(res.numAffectedRows ?? res.rows.length)}`,
            (error: Error) => `refused ${error.message.slice(0, 40)}`,
          );
        expect(outcome.startsWith('refused') || outcome === 'ok 0').toBe(true);
      }
      const after = await api('get', `${ownerDuesPath}/${due.id}`, owner.token);
      expect(after.body.data).toMatchObject({ dueStatus: 1, dueDate: null });
    });

    it('an Owner tenant naming another Society, or no Society, reads none of this Society’s dues', async () => {
      const a = await world();
      const b = await world();
      await raised(a.institutionId);
      expect(await count(asOwner(a.owner.person, b.societyId))).toBe(0);
      expect(await count({ personId: a.owner.person, roleCode: 2 })).toBe(0);
      expect(await count({ personId: a.owner.person, roleCode: 2, societyId: a.societyId })).toBe(
        1,
      );
      expect(await count({ personId: a.owner.person, roleCode: 4, societyId: a.societyId })).toBe(
        0,
      );
      expect(await count({ personId: a.owner.person, roleCode: 5, societyId: a.societyId })).toBe(
        0,
      );
    });
  });

  describe('Q6 a Society that is no longer active', () => {
    it('says what an Owner of a deactivated Society is served', async () => {
      const { societyId, institutionId, owner } = await world();
      await raised(institutionId);
      expect((await api('delete', `/v1/platform/societies/${societyId}`, admin)).status).toBe(200);
      const res = await api('get', ownerDuesPath, owner.token);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('Q7 many dues', () => {
    it('lists 40 dues across two Institutions newest first, in invoice order, with one name lookup each', async () => {
      const { societyId, institutionId, owner } = await world();
      const second = await api('post', '/v1/institutions', owner.token, {
        name: 'Hill View School',
        code: `I${newId().slice(-10)}`,
        address: { line1: '3 Hill Road' },
      });
      expect(second.status).toBe(201);
      await api('post', `/v1/platform/institutions/${second.body.data.id}/price-rates`, admin, {
        ratePerStudentAmount: '40.00',
        effectiveFromDate: '2026-04-01',
      });
      const made: DueLine[] = [];
      for (let i = 0; i < 40; i += 1) {
        made.push(await raised(i % 2 === 0 ? institutionId : second.body.data.id));
      }
      const view = await ownerList(owner.token);
      expect(view.dues.map((line) => line.invoiceNo)).toEqual(
        made.map((due) => due.invoiceNo).toReversed(),
      );
      const names = new Set(
        (view.dues as unknown as { institution: { name: string } }[]).map(
          (l) => l.institution.name,
        ),
      );
      expect([...names].toSorted()).toEqual(['Green Valley School', 'Hill View School']);
      expect(societyId).toBeDefined();
    });
  });
});
