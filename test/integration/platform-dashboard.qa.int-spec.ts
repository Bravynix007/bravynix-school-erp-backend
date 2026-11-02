import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { BackgroundMailer } from '../../src/platform/identity/index.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');

/** 10:00 on 1 June 2037 in India, in a financial year no other test uses. */
const TEST_DAY = '2037-06-01T04:30:00.000Z';
const TEST_YEAR = 'FY2037-38';

const dashboardPath = '/v1/platform/dashboard';
const duesPath = '/v1/platform/dues';

/** What the dashboard counts, as numbers, so a test can compare before and after (the database holds other data). */
const cents = (amount: unknown) => Math.round(Number(amount) * 100);

describe('QA: PLT-01 dashboard and Society outstanding dues, adversarial (API design 10.4b, 10.4f)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];

  const read = async () => {
    const res = await api('get', dashboardPath, admin);
    expect(res.status).toBe(200);
    return res.body.data as unknown as {
      societies: number;
      institutions: number;
      activeStudents: number | null;
      duesOutstandingAmount: string;
      duesCollectedThisMonthAmount: string;
      duesCollectedLastMonthAmount: string;
      openAiReports: number | null;
    };
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

  /** A Society with one Institution that is charged 50.00 a student from 1 April 2026. */
  const world = async () => {
    const societyId = await society();
    const owner = await fixtures.owner(societyId);
    const made = await api('post', '/v1/institutions', owner.token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
    });
    expect(made.status).toBe(201);
    const institutionId = made.body.data.id;
    const rate = await api(
      'post',
      `/v1/platform/institutions/${institutionId}/price-rates`,
      admin,
      { ratePerStudentAmount: '50.00', effectiveFromDate: '2026-04-01' },
    );
    expect(rate.status).toBe(201);
    return { societyId, institutionId, owner };
  };

  /** A due of `students` × 50.00 for its own period, so one Institution can have several. */
  const raise = async (institutionId: string, students: number, year: number) => {
    const res = await request(t.app.getHttpServer())
      .post(duesPath)
      .set('Authorization', `Bearer ${admin}`)
      .set('Idempotency-Key', newId())
      .send({
        institutionId,
        periodStartDate: `${year}-04-01`,
        periodEndDate: `${year + 1}-03-31`,
        studentCount: students,
        studentCountNote: 'Counted from the register',
      });
    expect(res.status).toBe(201);
    return res.body.data as { id: string; totalAmount: string };
  };

  const pay = async (id: string, paidDate: string) => {
    const res = await api('post', `${duesPath}/${id}/mark-paid`, admin, {
      version: 1,
      paidDate,
      paymentMode: 2,
    });
    expect(res.status).toBe(200);
  };

  /** A Super Admin token for the moved clock: the session row is written with the database's own time, so its expiry is lifted. */
  const signInAdmin = async () => {
    const token = await superAdminToken(t, ownerDb, superAdmin.id);
    await sql`update auth_sessions set idle_expires_at = '2040-01-01', absolute_expires_at = '2040-01-01'
      where user_id = ${superAdmin.id}`.execute(ownerDb);
    return token;
  };

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
    admin = await signInAdmin();
  });

  afterEach(async () => {
    await t.app.get(BackgroundMailer).flush();
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    await fixtures.cleanup();
  });

  /** A due raised on one Institution with a body of its own. */
  const raiseWith = async (institutionId: string, body: object) => {
    const res = await request(t.app.getHttpServer())
      .post(duesPath)
      .set('Authorization', `Bearer ${admin}`)
      .set('Idempotency-Key', newId())
      .send({
        institutionId,
        periodStartDate: '2026-04-01',
        periodEndDate: '2027-03-31',
        studentCount: 300,
        studentCountNote: 'Counted from the register',
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.data as { id: string; totalAmount: string };
  };

  const societyRow = async (societyId: string) => {
    const detail = await api('get', `/v1/platform/societies/${societyId}`, admin);
    expect(detail.status).toBe(200);
    return detail.body.data as unknown as {
      outstandingDuesAmount: string;
      institutionCount: number;
    };
  };

  const listed = async (query: string) => {
    const res = await api('get', `/v1/platform/societies?${query}`, admin);
    expect(res.status).toBe(200);
    return res.body.data as unknown as { id: string; outstandingDuesAmount: string }[];
  };

  const moveClock = async (at: string) => {
    t.clock.set(at);
    admin = await signInAdmin();
  };

  describe('Q1 amounts beyond one due', () => {
    it('adds 101 dues at the column maximum without failing: the dashboard, the list and the profile', async () => {
      const { societyId, institutionId } = await world();
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
      const before = await read();
      for (let i = 0; i < 101; i += 1) {
        await raiseWith(institutionId, {
          periodStartDate: '2027-01-01',
          studentCount: 100,
          adjustmentAmount: '0.99',
          adjustmentNote: 'Rounding',
        });
      }
      // 101 × 9,999,999,999.99 = 1,009,999,999,998.99, past what numeric(14,2) holds.
      const dashboard = await api('get', dashboardPath, admin);
      const detail = await api('get', `/v1/platform/societies/${societyId}`, admin);
      const list = await api(
        'get',
        `/v1/platform/societies?q=${encodeURIComponent('Sunrise')}&limit=100`,
        admin,
      );
      console.log(
        'QA-Q1 statuses (dashboard, detail, list):',
        dashboard.status,
        detail.status,
        list.status,
        dashboard.body.code ?? '',
      );
      expect([dashboard.status, detail.status, list.status]).toEqual([200, 200, 200]);
      expect(detail.body.data.outstandingDuesAmount).toBe('1009999999998.99');
      expect(
        BigInt(cents(dashboard.body.data.duesOutstandingAmount)) -
          BigInt(cents(before.duesOutstandingAmount)),
      ).toBe(100_999_999_999_899n);
    }, 120_000);
  });

  describe('Q2 the calendar months, in India', () => {
    it('in January, last month is the December before', async () => {
      const { institutionId } = await world();
      await moveClock('2038-01-15T06:00:00.000Z');
      const before = await read();
      const dec31 = await raise(institutionId, 10, 2026);
      const jan1 = await raise(institutionId, 20, 2027);
      const nov30 = await raise(institutionId, 40, 2028);
      await pay(dec31.id, '2037-12-31');
      await pay(jan1.id, '2038-01-01');
      await pay(nov30.id, '2037-11-30');
      const after = await read();
      expect(
        cents(after.duesCollectedThisMonthAmount) - cents(before.duesCollectedThisMonthAmount),
      ).toBe(100_000);
      expect(
        cents(after.duesCollectedLastMonthAmount) - cents(before.duesCollectedLastMonthAmount),
      ).toBe(50_000);
    });

    it('moves a payment from this month to last month exactly at 18:30 UTC on the last day', async () => {
      const { institutionId } = await world();
      await moveClock('2037-06-30T18:29:59.999Z');
      const due = await raise(institutionId, 10, 2026);
      await pay(due.id, '2037-06-30');
      const june = await read();
      await moveClock('2037-06-30T18:30:00.000Z');
      const july = await read();
      expect(
        cents(june.duesCollectedThisMonthAmount) - cents(july.duesCollectedThisMonthAmount),
      ).toBe(50_000);
      expect(
        cents(july.duesCollectedLastMonthAmount) - cents(june.duesCollectedLastMonthAmount),
      ).toBe(50_000);
    });

    it('handles 29 February in a leap year and 1 March after it', async () => {
      const { institutionId } = await world();
      await moveClock('2036-03-10T06:00:00.000Z');
      const before = await read();
      const feb29 = await raise(institutionId, 10, 2026);
      const mar1 = await raise(institutionId, 20, 2027);
      await pay(feb29.id, '2036-02-29');
      await pay(mar1.id, '2036-03-01');
      const after = await read();
      expect(
        cents(after.duesCollectedLastMonthAmount) - cents(before.duesCollectedLastMonthAmount),
      ).toBe(50_000);
      expect(
        cents(after.duesCollectedThisMonthAmount) - cents(before.duesCollectedThisMonthAmount),
      ).toBe(100_000);
      await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`delete from number_sequences where sequence_type = 3 and period_key in ('FY2035-36')`.execute(
          tx,
        );
      });
    });
  });

  describe('Q3 every change shows at once', () => {
    it('follows an edit, a cancellation and a payment in order, and a cancelled due never counts as collected', async () => {
      const { societyId, institutionId } = await world();
      const start = await read();
      const due = await raise(institutionId, 10, 2026);
      const other = await raise(institutionId, 4, 2027);
      const edited = await api('patch', `${duesPath}/${due.id}`, admin, {
        version: 1,
        adjustmentAmount: '-100.00',
        adjustmentNote: 'Discount',
      });
      expect(edited.status).toBe(200);
      let now = await read();
      expect(cents(now.duesOutstandingAmount) - cents(start.duesOutstandingAmount)).toBe(
        40_000 + 20_000,
      );
      expect((await societyRow(societyId)).outstandingDuesAmount).toBe('600.00');
      const cancelled = await api('post', `${duesPath}/${other.id}/cancel`, admin, {
        version: 1,
        reason: 'Raised twice',
      });
      expect(cancelled.status).toBe(200);
      now = await read();
      expect(cents(now.duesOutstandingAmount) - cents(start.duesOutstandingAmount)).toBe(40_000);
      expect(cents(now.duesCollectedThisMonthAmount)).toBe(
        cents(start.duesCollectedThisMonthAmount),
      );
      const paid = await api('post', `${duesPath}/${due.id}/mark-paid`, admin, {
        version: 2,
        paidDate: '2037-06-01',
        paymentMode: 3,
      });
      expect(paid.status).toBe(200);
      now = await read();
      expect(cents(now.duesOutstandingAmount)).toBe(cents(start.duesOutstandingAmount));
      expect(
        cents(now.duesCollectedThisMonthAmount) - cents(start.duesCollectedThisMonthAmount),
      ).toBe(40_000);
      expect((await societyRow(societyId)).outstandingDuesAmount).toBe('0.00');
    });
  });

  describe('Q4 the counts', () => {
    it('counts a Society with no Institution, drops an Institution when deactivated, and drops both when the Society is', async () => {
      const start = await read();
      const empty = await society();
      const { societyId, institutionId, owner } = await world();
      let now = await read();
      expect([now.societies - start.societies, now.institutions - start.institutions]).toEqual([
        2, 1,
      ]);
      expect((await api('delete', `/v1/institutions/${institutionId}`, owner.token)).status).toBe(
        200,
      );
      now = await read();
      expect([now.societies - start.societies, now.institutions - start.institutions]).toEqual([
        2, 0,
      ]);
      expect((await api('delete', `/v1/platform/societies/${empty}`, admin)).status).toBe(200);
      expect((await api('delete', `/v1/platform/societies/${societyId}`, admin)).status).toBe(200);
      now = await read();
      expect([now.societies - start.societies, now.institutions - start.institutions]).toEqual([
        0, 0,
      ]);
    });

    it('drops an active Institution from the count when its Society is deactivated', async () => {
      const start = await read();
      const { societyId } = await world();
      expect((await read()).institutions - start.institutions).toBe(1);
      expect((await api('delete', `/v1/platform/societies/${societyId}`, admin)).status).toBe(200);
      expect((await read()).institutions - start.institutions).toBe(0);
    });
  });

  describe('Q5 the Society list and profile', () => {
    it('gives each Society on every page its own total, and 0.00 to one whose only due is 0.00', async () => {
      const made: { id: string; owed: string }[] = [];
      for (let i = 0; i < 5; i += 1) {
        const { societyId, institutionId } = await world();
        if (i > 0) await raise(institutionId, i * 10, 2026);
        if (i === 0) await raiseWith(institutionId, { studentCount: 0, studentCountNote: null });
        made.push({ id: societyId, owed: (i * 500).toFixed(2) });
      }
      const ids = new Set(made.map((m) => m.id));
      const seen = new Map<string, string>();
      for (let page = 1; page <= 50; page += 1) {
        const rows = await listed(`limit=2&page=${page}&sort=createdAt`);
        if (rows.length === 0) break;
        for (const row of rows) if (ids.has(row.id)) seen.set(row.id, row.outstandingDuesAmount);
      }
      expect(Object.fromEntries(seen)).toEqual(Object.fromEntries(made.map((m) => [m.id, m.owed])));
    });

    it('still shows what a deactivated Society owes', async () => {
      const { societyId, institutionId } = await world();
      await raise(institutionId, 10, 2026);
      expect((await api('delete', `/v1/platform/societies/${societyId}`, admin)).status).toBe(200);
      const detail = await societyRow(societyId);
      console.log('QA-Q5 deactivated Society owes:', detail.outstandingDuesAmount);
      expect(detail.outstandingDuesAmount).toBe('500.00');
    });
  });

  describe('Q6 who may read it', () => {
    it('refuses a blocked Owner and a Super Admin with no context the same way as before', async () => {
      const { owner } = await world();
      const res = await api('get', dashboardPath, owner.token);
      expect(res.status).toBe(403);
      for (const bad of ['Bearer x', 'Basic abc', '']) {
        const raw = await request(t.app.getHttpServer())
          .get(dashboardPath)
          .set('Authorization', bad);
        expect([bad, raw.status]).toEqual([bad, 401]);
      }
    });
  });
});
