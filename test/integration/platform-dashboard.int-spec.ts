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

/** 10:00 on 1 June 2035 in India, in a financial year no other test uses. */
const TEST_DAY = '2035-06-01T04:30:00.000Z';
const TEST_YEAR = 'FY2035-36';

const dashboardPath = '/v1/platform/dashboard';
const duesPath = '/v1/platform/dues';

/** What the dashboard counts, as numbers, so a test can compare before and after (the database holds other data). */
const cents = (amount: unknown) => Math.round(Number(amount) * 100);

describe('PLT-01 dashboard and the outstanding dues of PLT-02 and PLT-04 (API design 10.4, 10.4b; PRD 9.6)', () => {
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

  describe('who may read it', () => {
    it('answers 401 without a token and 403 to a Society Owner', async () => {
      const none = await request(t.app.getHttpServer()).get(dashboardPath);
      expect(none.status).toBe(401);

      const { owner } = await world();
      const res = await api('get', dashboardPath, owner.token);
      expect(res.status).toBe(403);
    });

    it('answers 403 to an Institution Admin', async () => {
      const { societyId, institutionId } = await world();
      const institutionAdmin = await fixtures.institutionAdmin(societyId, [institutionId]);
      const res = await api('get', dashboardPath, institutionAdmin.token);
      expect(res.status).toBe(403);
    });
  });

  describe('the counts', () => {
    it('has the shape of the contract, with the figures that are not built yet as null', async () => {
      const res = await api('get', dashboardPath, admin);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        societies: expect.any(Number),
        institutions: expect.any(Number),
        activeStudents: null,
        duesOutstandingAmount: expect.stringMatching(/^\d+\.\d{2}$/),
        duesCollectedThisMonthAmount: expect.stringMatching(/^\d+\.\d{2}$/),
        duesCollectedLastMonthAmount: expect.stringMatching(/^\d+\.\d{2}$/),
        openAiReports: null,
      });
    });

    it('counts an active Society and its active Institution, and not those of a deactivated Society', async () => {
      const before = await read();
      const first = await world();
      const added = await read();
      expect(added.societies).toBe(before.societies + 1);
      expect(added.institutions).toBe(before.institutions + 1);

      const second = await world();
      expect((await read()).societies).toBe(before.societies + 2);
      const ended = await api('delete', `/v1/platform/societies/${second.societyId}`, admin);
      expect(ended.status).toBe(200);
      // The Institution is still active itself, but it sits in a Society that is not.
      expect(await read()).toMatchObject({
        societies: before.societies + 1,
        institutions: before.institutions + 1,
      });
      expect(first.societyId).not.toBe(second.societyId);
    });

    it('does not count an Institution that is not active', async () => {
      const { societyId } = await world();
      const before = await read();
      await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`insert into institutions (id, society_id, name, code, address_line_1, status)
          values (${newId()}, ${societyId}, 'Closed School', 'C', '1 Road', 0)`.execute(tx);
      });
      expect((await read()).institutions).toBe(before.institutions);
    });
  });

  describe('the dues', () => {
    it('adds what is due, and drops it again when the due is paid or cancelled', async () => {
      const { institutionId } = await world();
      const before = await read();
      const a = await raise(institutionId, 100, 2031); // 5000.00
      const b = await raise(institutionId, 200, 2032); // 10000.00
      const c = await raise(institutionId, 300, 2033); // 15000.00
      expect(
        cents((await read()).duesOutstandingAmount) - cents(before.duesOutstandingAmount),
      ).toBe(3_000_000);

      await pay(a.id, '2035-06-01');
      const cancelled = await api('post', `${duesPath}/${c.id}/cancel`, admin, {
        version: 1,
        reason: 'Raised twice',
      });
      expect(cancelled.status).toBe(200);
      const after = await read();
      expect(cents(after.duesOutstandingAmount) - cents(before.duesOutstandingAmount)).toBe(
        1_000_000,
      );
      expect(b.totalAmount).toBe('10000.00');
    });

    it('counts a payment in the month of its paid date, by India’s calendar, and nothing outside the two months', async () => {
      const { institutionId } = await world();
      const before = await read();
      const dues = [
        await raise(institutionId, 100, 2030), // 5000.00, paid two months ago
        await raise(institutionId, 200, 2031), // 10000.00, paid on the last day of last month
        await raise(institutionId, 300, 2032), // 15000.00, paid on the first day of this month
        await raise(institutionId, 400, 2033), // 20000.00, paid on the last day of this month
      ];
      await pay(dues[0]!.id, '2035-04-30');
      await pay(dues[1]!.id, '2035-05-31');
      await pay(dues[2]!.id, '2035-06-01');
      // A paid date later than today is refused, so the last day of this month is the day itself.
      const future = await api('post', `${duesPath}/${dues[3]!.id}/mark-paid`, admin, {
        version: 1,
        paidDate: '2035-06-30',
        paymentMode: 2,
      });
      expect(future.status).toBe(400);

      const after = await read();
      expect(
        cents(after.duesCollectedLastMonthAmount) - cents(before.duesCollectedLastMonthAmount),
      ).toBe(1_000_000);
      expect(
        cents(after.duesCollectedThisMonthAmount) - cents(before.duesCollectedThisMonthAmount),
      ).toBe(1_500_000);
    });

    it('moves the months on at midnight in India, not at midnight UTC', async () => {
      const { institutionId } = await world();
      const due = await raise(institutionId, 100, 2031); // 5000.00
      t.clock.set('2035-06-30T05:00:00.000Z');
      admin = await signInAdmin();
      await pay(due.id, '2035-06-30');
      const june = await read();

      t.clock.set('2035-06-30T18:40:00.000Z'); // 00:10 on 1 July in India, still 30 June in UTC
      admin = await signInAdmin();
      const july = await read();
      expect(july.duesCollectedLastMonthAmount).toBe(june.duesCollectedThisMonthAmount);
      expect(cents(july.duesCollectedThisMonthAmount)).toBe(0);
    });
  });

  describe('PLT-02 and PLT-04 outstanding dues', () => {
    it('is 0.00 for a Society with no dues, on the list, the detail and the create answer', async () => {
      const created = await api('post', '/v1/platform/societies', admin, {
        name: 'Fresh Trust',
        code: `S${newId().slice(-12)}`,
      });
      expect(created.status).toBe(201);
      societies.push(created.body.data.id);
      expect(created.body.data.outstandingDuesAmount).toBe('0.00');

      const detail = await api('get', `/v1/platform/societies/${created.body.data.id}`, admin);
      expect(detail.body.data.outstandingDuesAmount).toBe('0.00');
      const list = await api(
        'get',
        `/v1/platform/societies?q=${encodeURIComponent('Fresh Trust')}&limit=100`,
        admin,
      );
      const row = (list.body.data as unknown as { id: string; outstandingDuesAmount: string }[])
        .filter((line) => line.id === created.body.data.id)
        .at(0);
      expect(row?.outstandingDuesAmount).toBe('0.00');
    });

    it('sums the dues still owed by each Society, not the ones paid or cancelled and not another Society’s', async () => {
      const a = await world();
      const b = await world();
      const owes = await raise(a.institutionId, 100, 2031); // 5000.00
      await raise(a.institutionId, 200, 2032); // 10000.00
      const paid = await raise(a.institutionId, 300, 2033);
      const cancelled = await raise(a.institutionId, 400, 2034);
      await raise(b.institutionId, 20, 2031); // 1000.00
      await pay(paid.id, '2035-06-01');
      await api('post', `${duesPath}/${cancelled.id}/cancel`, admin, {
        version: 1,
        reason: 'Raised twice',
      });

      const list = await api('get', '/v1/platform/societies?limit=100&sort=-createdAt', admin);
      const amounts = new Map(
        (list.body.data as unknown as { id: string; outstandingDuesAmount: string }[]).map(
          (line) => [line.id, line.outstandingDuesAmount],
        ),
      );
      expect(amounts.get(a.societyId)).toBe('15000.00');
      expect(amounts.get(b.societyId)).toBe('1000.00');

      const detail = await api('get', `/v1/platform/societies/${a.societyId}`, admin);
      expect(detail.body.data.outstandingDuesAmount).toBe('15000.00');

      await pay(owes.id, '2035-06-01');
      const again = await api('get', `/v1/platform/societies/${a.societyId}`, admin);
      expect(again.body.data.outstandingDuesAmount).toBe('10000.00');
    });
  });
});
