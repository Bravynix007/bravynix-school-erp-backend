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
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

/** A day in a financial year no other test uses, so the invoice counter starts from 1 here. */
const TEST_DAY = '2031-06-01T04:30:00.000Z';
const TEST_YEAR = 'FY2031-32';

type Method = 'get' | 'post' | 'patch' | 'delete';

const duesPath = '/v1/platform/dues';
const dueAt = (id: string) => `${duesPath}/${id}`;

const fieldsOf = (res: { body: { errors?: { field: string; code: string }[] } }) =>
  res.body.errors?.map((e) => [e.field, e.code]);
const quotePath = (institutionId: string) => `/v1/platform/institutions/${institutionId}/due-quote`;

/** The number part of `BNX/FY2031-32/0007`. */
const numberOf = (invoiceNo: string) => Number(invoiceNo.split('/').at(-1));

const dueBody = (institutionId: string, overrides: object = {}) => ({
  institutionId,
  periodStartDate: '2026-04-01',
  periodEndDate: '2027-03-31',
  studentCount: 300,
  studentCountNote: 'Counted from the register',
  ...overrides,
});

describe('PLT-24 to PLT-30 platform dues (PRD 9.3, API design 10.22)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const owners = new Map<string, SignedInPerson>();

  const asAdmin = (method: Method, path: string, body: object = {}) =>
    api(method, path, admin, body);

  const ownerOf = async (societyId: string) => {
    let owner = owners.get(societyId);
    if (!owner) {
      owner = await fixtures.owner(societyId);
      owners.set(societyId, owner);
    }
    return owner;
  };

  const society = async () => {
    const res = await asAdmin('post', '/v1/platform/societies', {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    expect(res.status).toBe(201);
    societies.push(res.body.data.id);
    return res.body.data.id;
  };

  const institution = async (societyId: string) => {
    const owner = await ownerOf(societyId);
    const res = await api('post', '/v1/institutions', owner.token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
    });
    expect(res.status).toBe(201);
    return res.body.data as { id: string };
  };

  const setRate = async (institutionId: string, amount: string, effectiveFromDate: string) => {
    const res = await asAdmin('post', `/v1/platform/institutions/${institutionId}/price-rates`, {
      ratePerStudentAmount: amount,
      effectiveFromDate,
    });
    expect(res.status).toBe(201);
    return res.body.data.id;
  };

  /** A Society with an Owner and one Institution that is charged 50.00 from 1 April 2026. */
  const world = async () => {
    const societyId = await society();
    const inst = await institution(societyId);
    const rateId = await setRate(inst.id, '50.00', '2026-04-01');
    return { societyId, institutionId: inst.id, rateId, owner: await ownerOf(societyId) };
  };

  const raise = (body: object, key: string | null = newId(), token = admin) => {
    let req = request(t.app.getHttpServer()).post(duesPath).set('Authorization', `Bearer ${token}`);
    if (key !== null) req = req.set('Idempotency-Key', key);
    return req.send(body);
  };

  const raised = async (institutionId: string, overrides: object = {}) => {
    const res = await raise(dueBody(institutionId, overrides));
    expect(res.status).toBe(201);
    return res.body.data as { id: string; invoiceNo: string; totalAmount: string };
  };

  /** The IDs a list answers with, in a fixed order. */
  const listedIds = async (query: string) =>
    ((await asAdmin('get', `${duesPath}?${query}`)).body.data as unknown as { id: string }[])
      .map((row) => row.id)
      .toSorted();

  /** What a tenant reads of the dues table. */
  const read = (tenant: object) =>
    database.transaction(tenant, (tx) => sql`select id from platform_dues`.execute(tx));

  /** The due notices an address was sent; its sign-in codes are not counted. */
  const dueMails = (address: string) =>
    t.email.all().filter((mail) => mail.to === address && mail.template === 'platform-due-raised');

  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      society_id: string;
      institution_id: string | null;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);

  /** The audit entries after the raise, oldest first. */
  const later = async (id: string) => (await audit(id)).slice(1);

  const dueRows = async (institutionId: string) =>
    (
      await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        return sql<{ n: number }>`select count(*)::int as n from platform_dues
          where institution_id = ${institutionId}`.execute(tx);
      })
    ).rows[0]!.n;

  /** PLT-28 with the version the due was read at. */
  const edit = (id: string, body: object = {}, version = 1) =>
    asAdmin('patch', dueAt(id), { version, ...body });

  /** PLT-29: paid on 10 May 2026 by bank transfer unless told otherwise. */
  const pay = (id: string, body: object = {}, version = 1) =>
    asAdmin('post', `${dueAt(id)}/mark-paid`, {
      version,
      paidDate: '2026-05-10',
      paymentMode: 2,
      ...body,
    });

  /** PLT-30. */
  const cancel = (id: string, body: object = {}, version = 1) =>
    asAdmin('post', `${dueAt(id)}/cancel`, { version, reason: 'Raised twice', ...body });

  /**
   * A Super Admin token for the moved clock. The session row is written with the database's own time,
   * so its expiry is lifted past the test clock.
   */
  const signInAdmin = async (personId = superAdmin.id) => {
    const token = await superAdminToken(t, ownerDb, personId);
    await sql`update auth_sessions set idle_expires_at = '2040-01-01', absolute_expires_at = '2040-01-01'
      where user_id = ${personId}`.execute(ownerDb);
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
    admin = await signInAdmin();
  });

  afterEach(async () => {
    await t.app.get(BackgroundMailer).flush();
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    owners.clear();
    await fixtures.cleanup();
  });

  describe('who may call', () => {
    it('keeps dues from Owners and Admins and from callers with no token', async () => {
      const { societyId, institutionId, owner } = await world();
      const adminOf = await fixtures.institutionAdmin(societyId, [institutionId]);
      const due = await raised(institutionId);
      const period = '?periodStartDate=2026-04-01&periodEndDate=2027-03-31';

      for (const token of [owner.token, adminOf.token]) {
        const calls = [
          api('get', `${quotePath(institutionId)}${period}`, token),
          api('get', duesPath, token),
          api('get', `${duesPath}/${due.id}`, token),
          api('post', duesPath, token, dueBody(institutionId)),
        ];
        for (const res of await Promise.all(calls)) {
          expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
        }
      }
      const http = request(t.app.getHttpServer());
      expect((await http.get(duesPath)).status).toBe(401);
      expect((await http.post(duesPath).send(dueBody(institutionId))).status).toBe(401);
      expect(await dueRows(institutionId)).toBe(1);
    });
  });

  describe('PLT-24 quote', () => {
    it('gives the automatic count and the rate in force on the first day of the period', async () => {
      const { institutionId, rateId } = await world();
      const newRate = await setRate(institutionId, '65.00', '2026-10-01');
      const query = (start: string) =>
        asAdmin(
          'get',
          `${quotePath(institutionId)}?periodStartDate=${start}&periodEndDate=2027-03-31`,
        );

      expect((await query('2026-04-01')).body.data).toEqual({
        institutionId,
        periodStartDate: '2026-04-01',
        periodEndDate: '2027-03-31',
        studentCountAuto: 0,
        priceRateId: rateId,
        ratePerStudentAmount: '50.00',
        rateEffectiveFromDate: '2026-04-01',
        baseAmount: '0.00',
      });
      // The last day under the old rate, and the first under the new one.
      expect((await query('2026-09-30')).body.data).toMatchObject({ priceRateId: rateId });
      expect((await query('2026-10-01')).body.data).toMatchObject({
        priceRateId: newRate,
        ratePerStudentAmount: '65.00',
      });
    });

    it('answers 200 with no rate when the first rate starts after the period', async () => {
      const { institutionId } = await world();
      const res = await asAdmin(
        'get',
        `${quotePath(institutionId)}?periodStartDate=2026-03-31&periodEndDate=2027-03-31`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        priceRateId: null,
        ratePerStudentAmount: null,
        rateEffectiveFromDate: null,
        baseAmount: null,
      });
    });

    it.each([
      ['no dates', ''],
      ['an end before the start', '?periodStartDate=2026-04-02&periodEndDate=2026-04-01'],
      ['a date that does not exist', '?periodStartDate=2026-02-30&periodEndDate=2027-03-31'],
    ])('answers 400 for %s', async (_what, query) => {
      const { institutionId } = await world();
      const res = await asAdmin('get', `${quotePath(institutionId)}${query}`);
      expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('answers 404 for an unknown Institution, and for an ID that is not a UUID', async () => {
      const query = '?periodStartDate=2026-04-01&periodEndDate=2027-03-31';
      expect((await asAdmin('get', `${quotePath(missing)}${query}`)).status).toBe(404);
      expect((await asAdmin('get', `${quotePath('nope')}${query}`)).status).toBe(404);
    });
  });

  describe('PLT-26 raise a due', () => {
    it('answers 201 with the whole due: the frozen rate, the amounts, the invoice number and the author', async () => {
      const { societyId, institutionId, rateId } = await world();
      const res = await raise(
        dueBody(institutionId, {
          adjustmentAmount: '-500.00',
          adjustmentNote: 'Opening discount',
          dueDate: '2026-05-15',
        }),
      );
      expect(res.status).toBe(201);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(res.body.code).toBe('CREATED');
      expect(res.body.data).toEqual({
        id: expect.any(String),
        invoiceNo: `BNX/${TEST_YEAR}/0001`,
        societyId,
        societyName: 'Sunrise Trust',
        institution: { id: institutionId, name: 'Green Valley School' },
        periodStartDate: '2026-04-01',
        periodEndDate: '2027-03-31',
        studentCountAuto: 0,
        studentCount: 300,
        studentCountNote: 'Counted from the register',
        priceRateId: rateId,
        ratePerStudentAmount: '50.00',
        baseAmount: '15000.00',
        adjustmentAmount: '-500.00',
        adjustmentNote: 'Opening discount',
        totalAmount: '14500.00',
        dueDate: '2026-05-15',
        dueStatus: 1,
        paidDate: null,
        paymentMode: null,
        paymentReference: null,
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        version: 1,
        createdAt: expect.stringMatching(/Z$/),
        createdBy: { id: superAdmin.id, displayName: expect.any(String), roleName: 'Super Admin' },
        updatedAt: expect.stringMatching(/Z$/),
        updatedBy: { id: superAdmin.id, displayName: expect.any(String), roleName: 'Super Admin' },
      });
    });

    it('defaults the adjustment to nothing, takes no due date, and a count of zero needs no note', async () => {
      const { institutionId } = await world();
      const res = await raise({
        institutionId,
        periodStartDate: '2026-04-01',
        periodEndDate: '2026-04-01',
        studentCount: 0,
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        adjustmentAmount: '0.00',
        adjustmentNote: null,
        studentCountNote: null,
        baseAmount: '0.00',
        totalAmount: '0.00',
        dueDate: null,
      });
    });

    it('copies the rate in force on the first day of the period, and a later rate change never alters the due', async () => {
      const { institutionId, rateId } = await world();
      const first = await raised(institutionId);
      const newRate = await setRate(institutionId, '80.00', '2026-10-01');

      const stored = await asAdmin('get', `${duesPath}/${first.id}`);
      expect(stored.body.data).toMatchObject({
        priceRateId: rateId,
        ratePerStudentAmount: '50.00',
        totalAmount: '15000.00',
      });
      // A period that starts under the new rate uses it; one that only ends under it does not.
      const second = await raise(dueBody(institutionId, { periodStartDate: '2026-10-01' }));
      expect(second.body.data).toMatchObject({
        priceRateId: newRate,
        ratePerStudentAmount: '80.00',
        totalAmount: '24000.00',
      });
      const spanning = await raise(dueBody(institutionId, { periodStartDate: '2026-04-01' }));
      expect(spanning.body.data).toMatchObject({ ratePerStudentAmount: '50.00' });
    });

    it('audits the raise with the Society and Institution, so the Society’s Owners can see it', async () => {
      const { societyId, institutionId } = await world();
      const due = await raised(institutionId);
      const [entry, ...rest] = await audit(due.id);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        action: 'platform_due.raise',
        actor_user_id: superAdmin.id,
        society_id: societyId,
        institution_id: institutionId,
        new_values: {
          invoice_no: due.invoiceNo,
          student_count: 300,
          rate_per_student_amount: '50.00',
          total_amount: '15000.00',
          due_status: 1,
        },
      });
    });

    it('numbers dues one after another without a gap, also across refusals and parallel requests', async () => {
      const { institutionId } = await world();
      const numbers: number[] = [];
      numbers.push(numberOf((await raised(institutionId)).invoiceNo));

      // Three refusals take no number.
      await raise(dueBody(institutionId, { studentCountNote: undefined }));
      await raise(dueBody(institutionId, { periodStartDate: '2020-01-01' }));
      await raise(dueBody(institutionId, { adjustmentAmount: '-99999.00', adjustmentNote: 'x' }));

      const together = await Promise.all(
        Array.from({ length: 5 }, () => raise(dueBody(institutionId))),
      );
      expect(together.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
      numbers.push(...together.map((res) => numberOf(res.body.data.invoiceNo)));

      expect(numbers.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await dueRows(institutionId)).toBe(6);
    });

    it('starts the counter again at 1 on 1 April, in India', async () => {
      const { institutionId } = await world();
      // 19:00 UTC on 31 March is 00:30 on 1 April in India.
      t.clock.set('2032-03-31T19:00:00.000Z');
      admin = await signInAdmin();
      expect((await raised(institutionId)).invoiceNo).toBe('BNX/FY2032-33/0001');
      t.clock.set('2032-03-31T18:00:00.000Z');
      admin = await signInAdmin();
      expect((await raised(institutionId)).invoiceNo).toBe(`BNX/${TEST_YEAR}/0001`);
      await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`delete from number_sequences where period_key = 'FY2032-33'`.execute(tx);
      });
    });

    describe('the rules', () => {
      it('answers 422 NO_RATE_IN_FORCE on periodStartDate when no rate starts on or before it, and writes nothing', async () => {
        const societyId = await society();
        const inst = await institution(societyId);
        const none = await raise(dueBody(inst.id));
        expect([none.status, none.body.code]).toEqual([422, 'NO_RATE_IN_FORCE']);
        expect(none.body.errors).toContainEqual(
          expect.objectContaining({ field: 'periodStartDate', code: 'NO_RATE_IN_FORCE' }),
        );

        await setRate(inst.id, '50.00', '2026-04-02');
        const early = await raise(dueBody(inst.id, { periodStartDate: '2026-04-01' }));
        expect(early.body.code).toBe('NO_RATE_IN_FORCE');
        expect(await dueRows(inst.id)).toBe(0);
        // The rate starting on the first day itself is in force.
        expect((await raise(dueBody(inst.id, { periodStartDate: '2026-04-02' }))).status).toBe(201);
      });

      it('answers 422 TOTAL_NEGATIVE on adjustmentAmount, and accepts a total of exactly zero', async () => {
        const { institutionId } = await world();
        const base = { adjustmentNote: 'Waived', studentCount: 10, studentCountNote: 'Counted' };
        const below = await raise(dueBody(institutionId, { ...base, adjustmentAmount: '-500.01' }));
        expect([below.status, below.body.code]).toEqual([422, 'TOTAL_NEGATIVE']);
        expect(below.body.errors).toContainEqual(
          expect.objectContaining({ field: 'adjustmentAmount', code: 'TOTAL_NEGATIVE' }),
        );
        const zero = await raise(dueBody(institutionId, { ...base, adjustmentAmount: '-500.00' }));
        expect(zero.status).toBe(201);
        expect(zero.body.data).toMatchObject({ baseAmount: '500.00', totalAmount: '0.00' });
      });

      it('answers 422 NOTE_REQUIRED, naming each missing note', async () => {
        const { institutionId } = await world();
        const both = await raise(
          dueBody(institutionId, { studentCountNote: undefined, adjustmentAmount: '10.00' }),
        );
        expect([both.status, both.body.code]).toEqual([422, 'NOTE_REQUIRED']);
        expect(both.body.errors).toEqual([
          expect.objectContaining({ field: 'studentCountNote', code: 'NOTE_REQUIRED' }),
          expect.objectContaining({ field: 'adjustmentNote', code: 'NOTE_REQUIRED' }),
        ]);
        const one = await raise(
          dueBody(institutionId, { adjustmentAmount: '10.00', adjustmentNote: null }),
        );
        expect(one.body.errors).toEqual([
          expect.objectContaining({ field: 'adjustmentNote', code: 'NOTE_REQUIRED' }),
        ]);
      });

      it('answers 400 OUT_OF_RANGE on the field whose value the amount columns cannot hold', async () => {
        const { institutionId } = await world();
        await setRate(institutionId, '99999999.99', '2027-01-01');
        const big = await raise(
          dueBody(institutionId, { periodStartDate: '2027-01-01', studentCount: 1_000_000 }),
        );
        expect([big.status, big.body.code]).toEqual([400, 'VALIDATION_FAILED']);
        expect(big.body.errors).toContainEqual(
          expect.objectContaining({ field: 'studentCount', code: 'OUT_OF_RANGE' }),
        );
      });

      it('answers 400 for a period that ends before it starts', async () => {
        const { institutionId } = await world();
        const res = await raise(dueBody(institutionId, { periodEndDate: '2026-03-31' }));
        expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
        expect(res.body.errors).toContainEqual(
          expect.objectContaining({ field: 'periodEndDate', code: 'OUT_OF_RANGE' }),
        );
      });

      it('answers 409 INVALID_STATE for a deactivated Institution or Society, and 404 for an unknown one', async () => {
        const { societyId, institutionId, owner } = await world();
        await api('delete', `/v1/institutions/${institutionId}`, owner.token);
        const closed = await raise(dueBody(institutionId));
        expect([closed.status, closed.body.code]).toEqual([409, 'INVALID_STATE']);

        const other = await world();
        await asAdmin('delete', `/v1/platform/societies/${other.societyId}`);
        const inactive = await raise(dueBody(other.institutionId));
        expect([inactive.status, inactive.body.code]).toEqual([409, 'INVALID_STATE']);

        expect(societyId).toBeDefined();
        expect((await raise(dueBody(missing))).status).toBe(404);
        expect(await dueRows(institutionId)).toBe(0);
        expect(await dueRows(other.institutionId)).toBe(0);
      });
    });

    describe('the body', () => {
      it.each([
        ['no Institution', { institutionId: undefined }, 'institutionId', 'INVALID_FORMAT'],
        ['no period start', { periodStartDate: undefined }, 'periodStartDate', 'INVALID_TYPE'],
        [
          'a date that does not exist',
          { periodEndDate: '2027-02-30' },
          'periodEndDate',
          'INVALID_FORMAT',
        ],
        ['a count as text', { studentCount: '300' }, 'studentCount', 'INVALID_TYPE'],
        ['a fractional count', { studentCount: 3.5 }, 'studentCount', 'INVALID_TYPE'],
        ['a negative count', { studentCount: -1 }, 'studentCount', 'OUT_OF_RANGE'],
        ['an adjustment as a number', { adjustmentAmount: 5 }, 'adjustmentAmount', 'INVALID_TYPE'],
        [
          'an adjustment with one decimal',
          { adjustmentAmount: '5.5' },
          'adjustmentAmount',
          'INVALID_FORMAT',
        ],
        ['a blank note', { studentCountNote: '' }, 'studentCountNote', 'TOO_SHORT'],
        ['a due date in another format', { dueDate: '15/05/2026' }, 'dueDate', 'INVALID_FORMAT'],
        ['an invoice number of its own', { invoiceNo: 'BNX/1' }, 'invoiceNo', 'FIELD_NOT_ALLOWED'],
        ['a total of its own', { totalAmount: '1.00' }, 'totalAmount', 'FIELD_NOT_ALLOWED'],
      ])('answers 400 for %s', async (_what, overrides, field, code) => {
        const { institutionId } = await world();
        const res = await raise({ ...dueBody(institutionId), ...overrides });
        expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
        expect(res.body.errors).toContainEqual(expect.objectContaining({ field, code }));
        expect(await dueRows(institutionId)).toBe(0);
      });

      it('needs an Idempotency-Key that is a UUID', async () => {
        const { institutionId } = await world();
        const none = await raise(dueBody(institutionId), null);
        expect([none.status, none.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
        const bad = await raise(dueBody(institutionId), 'not-a-uuid');
        expect(bad.status).toBe(400);
        expect(bad.body.errors).toContainEqual(
          expect.objectContaining({ field: 'Idempotency-Key', code: 'INVALID_FORMAT' }),
        );
        expect(await dueRows(institutionId)).toBe(0);
      });
    });

    describe('the same request again (Idempotency-Key)', () => {
      it('gives the stored answer back with Idempotent-Replayed, without a second due, number, audit entry or email', async () => {
        const { institutionId, owner } = await world();
        const key = newId();
        const one = await raise(dueBody(institutionId), key);
        await t.app.get(BackgroundMailer).flush();
        const again = await raise(dueBody(institutionId), key);
        await t.app.get(BackgroundMailer).flush();

        expect([one.status, again.status]).toEqual([201, 201]);
        expect(one.headers['idempotent-replayed']).toBeUndefined();
        expect(again.headers['idempotent-replayed']).toBe('true');
        expect(again.body.data).toEqual(one.body.data);
        expect(await dueRows(institutionId)).toBe(1);
        expect(await audit(one.body.data.id)).toHaveLength(1);
        expect(dueMails(owner.email)).toHaveLength(1);
        // The next due takes number 2: the replay took none.
        expect((await raised(institutionId)).invoiceNo).toBe(`BNX/${TEST_YEAR}/0002`);
      });

      it('answers 422 IDEMPOTENCY_KEY_REUSED for the same key with another body', async () => {
        const { institutionId } = await world();
        const key = newId();
        expect((await raise(dueBody(institutionId), key)).status).toBe(201);
        const other = await raise(dueBody(institutionId, { studentCount: 301 }), key);
        expect([other.status, other.body.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
        expect(await dueRows(institutionId)).toBe(1);
      });

      it('sends a stored refusal again as the same refusal, without the replay header', async () => {
        const { institutionId } = await world();
        const key = newId();
        const body = dueBody(institutionId, { studentCountNote: undefined });
        const one = await raise(body, key);
        const again = await raise(body, key);
        expect([one.status, one.body.code]).toEqual([422, 'NOTE_REQUIRED']);
        expect([again.status, again.body.code]).toEqual([422, 'NOTE_REQUIRED']);
        expect(again.headers['idempotent-replayed']).toBeUndefined();
        expect(again.body.errors).toEqual(one.body.errors);
      });

      it('lets two identical requests at once make one due', async () => {
        const { institutionId } = await world();
        const key = newId();
        const answers = await Promise.all([
          raise(dueBody(institutionId), key),
          raise(dueBody(institutionId), key),
        ]);
        expect(answers.map((answer) => answer.status).toSorted()).toSatisfy(
          (statuses: number[]) =>
            JSON.stringify(statuses) === '[201,201]' || JSON.stringify(statuses) === '[201,409]',
        );
        expect(await dueRows(institutionId)).toBe(1);
        const busy = answers.find((answer) => answer.status === 409);
        if (busy) expect(busy.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      });

      it('keeps one person’s key from showing another’s result', async () => {
        const { institutionId } = await world();
        const key = newId();
        const mine = await raise(dueBody(institutionId), key);
        const second = await signInAdmin(personaByKey('SA2').id);
        const theirs = await raise(dueBody(institutionId, { studentCount: 1 }), key, second);
        expect(theirs.status).toBe(201);
        expect(theirs.body.data.id).not.toBe(mine.body.data.id);
        expect(await dueRows(institutionId)).toBe(2);
      });
    });

    describe('telling the Society’s Owners', () => {
      it('emails the Owner once, with the invoice, the Institution, the period and the amount in rupees', async () => {
        const { institutionId, owner } = await world();
        const due = await raised(institutionId, { dueDate: '2026-05-15' });
        await t.app.get(BackgroundMailer).flush();

        expect(dueMails(owner.email)).toHaveLength(1);
        const mail = t.email.latest(owner.email, 'platform-due-raised')!;
        expect(mail.subject).toBe(`Invoice ${due.invoiceNo} from BravyNix`);
        expect(mail.text).toContain('Green Valley School (Sunrise Trust)');
        expect(mail.text).toContain('Period: 1 Apr 2026 to 31 Mar 2027');
        expect(mail.text).toContain('Amount: ₹15,000.00');
        expect(mail.text).toContain('Pay by: 15 May 2026');
      });

      it('sends nothing for a refused due, and still makes the due when the Society has no Owner who can sign in', async () => {
        const { institutionId, owner } = await world();
        await raise(dueBody(institutionId, { studentCountNote: undefined }));
        await t.app.get(BackgroundMailer).flush();
        expect(dueMails(owner.email)).toHaveLength(0);

        const { rows } = await sql<{ version: number }>`select version from users
          where id = ${owner.person}`.execute(ownerDb);
        const blocked = await asAdmin('post', `/v1/platform/users/${owner.person}/block`, {
          version: rows[0]!.version,
          reason: 'Testing',
        });
        expect(blocked.status).toBe(200);
        const res = await raise(dueBody(institutionId));
        await t.app.get(BackgroundMailer).flush();
        expect(res.status).toBe(201);
        expect(dueMails(owner.email)).toHaveLength(0);
      });
    });

    it('answers 409 RESOURCE_BUSY with Retry-After when a lock is not free within 5 seconds, stores no refusal, and the same key then succeeds', async () => {
      const { institutionId } = await world();
      expect((await raised(institutionId)).invoiceNo).toBe(`BNX/${TEST_YEAR}/0001`);

      // Another transaction holds the invoice counter, as a slow raise would.
      let release!: () => void;
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`select 1 from number_sequences
          where sequence_type = 3 and period_key = ${TEST_YEAR} for update`.execute(tx);
        locked();
        await hold;
      });
      await isLocked;

      const key = newId();
      const busy = await raise(dueBody(institutionId), key);
      expect([busy.status, busy.body.code]).toEqual([409, 'RESOURCE_BUSY']);
      expect(busy.headers['retry-after']).toBe('1');
      release();
      await holder;

      const retry = await raise(dueBody(institutionId), key);
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
      expect(retry.body.data.invoiceNo).toBe(`BNX/${TEST_YEAR}/0002`);
      expect(await dueRows(institutionId)).toBe(2);
    }, 30_000);
  });

  describe('PLT-27 read a due', () => {
    it('returns the due as it was raised, and 404 for an unknown due or an ID that is not a UUID', async () => {
      const { institutionId } = await world();
      const made = await raise(dueBody(institutionId, { dueDate: '2026-05-15' }));
      const res = await asAdmin('get', `${duesPath}/${made.body.data.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(made.body.data);
      expect((await asAdmin('get', `${duesPath}/${missing}`)).status).toBe(404);
      expect((await asAdmin('get', `${duesPath}/nope`)).status).toBe(404);
    });
  });

  describe('PLT-25 list dues', () => {
    it('lists the newest first with the Society, Institution, period, amount and status of each', async () => {
      const { societyId, institutionId } = await world();
      const first = await raised(institutionId);
      const second = await raised(institutionId, { dueDate: '2026-05-15' });
      const res = await asAdmin('get', `${duesPath}?institutionId=${institutionId}`);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, totalItems: 2, totalPages: 1 });
      expect(res.body.data).toEqual([
        {
          id: second.id,
          invoiceNo: second.invoiceNo,
          societyId,
          societyName: 'Sunrise Trust',
          institution: { id: institutionId, name: 'Green Valley School' },
          periodStartDate: '2026-04-01',
          periodEndDate: '2027-03-31',
          totalAmount: '15000.00',
          dueStatus: 1,
          dueDate: '2026-05-15',
          paidDate: null,
        },
        expect.objectContaining({ id: first.id, dueDate: null }),
      ]);
    });

    it('filters by Society, Institution and status, and by part of the invoice number', async () => {
      const one = await world();
      const two = await world();
      const a = await raised(one.institutionId);
      const b = await raised(one.institutionId);
      const c = await raised(two.institutionId);
      expect((await pay(b.id)).status).toBe(200);

      expect(await listedIds(`societyId=${one.societyId}`)).toEqual([a.id, b.id].toSorted());
      expect(await listedIds(`societyId=${two.societyId}`)).toEqual([c.id]);
      expect(await listedIds(`institutionId=${two.institutionId}`)).toEqual([c.id]);
      expect(await listedIds(`institutionId=${one.institutionId}&dueStatus=2`)).toEqual([b.id]);
      expect(await listedIds(`institutionId=${one.institutionId}&dueStatus=1`)).toEqual([a.id]);
      expect(await listedIds(`institutionId=${one.institutionId}&dueStatus=1&dueStatus=2`)).toEqual(
        [a.id, b.id].toSorted(),
      );
      expect(await listedIds(`institutionId=${one.institutionId}&dueStatus=0`)).toEqual([]);
      expect(await listedIds(`q=${encodeURIComponent(c.invoiceNo)}`)).toEqual([c.id]);
      expect(
        await listedIds(`q=${encodeURIComponent('FY2031-32/000')}&societyId=${one.societyId}`),
      ).toEqual([a.id, b.id].toSorted());
    });

    it('sorts, pages, and refuses a sort or a status it does not know', async () => {
      const { institutionId } = await world();
      await raised(institutionId, { studentCount: 10 });
      await raised(institutionId, { studentCount: 30 });
      await raised(institutionId, { studentCount: 20 });
      const base = `${duesPath}?institutionId=${institutionId}`;

      const byTotal = await asAdmin('get', `${base}&sort=-totalAmount`);
      expect(
        (byTotal.body.data as unknown as { totalAmount: string }[]).map((row) => row.totalAmount),
      ).toEqual(['1500.00', '1000.00', '500.00']);

      const secondPage = await asAdmin('get', `${base}&sort=invoiceNo&page=2&limit=2`);
      expect(secondPage.body.meta).toEqual({ page: 2, limit: 2, totalItems: 3, totalPages: 2 });
      expect(
        (secondPage.body.data as unknown as { invoiceNo: string }[]).map((row) =>
          numberOf(row.invoiceNo),
        ),
      ).toEqual([3]);

      const unknownSort = await asAdmin('get', `${base}&sort=societyName`);
      expect([unknownSort.status, unknownSort.body.code]).toEqual([400, 'INVALID_SORT']);
      expect((await asAdmin('get', `${base}&dueStatus=3`)).status).toBe(400);
      expect((await asAdmin('get', `${duesPath}?societyId=x`)).status).toBe(400);
    });

    it('puts a due with no due date last, whichever way the due dates are sorted', async () => {
      const { institutionId } = await world();
      const none = await raised(institutionId);
      const early = await raised(institutionId, { dueDate: '2026-05-15' });
      const late = await raised(institutionId, { dueDate: '2026-08-15' });
      const order = async (sort: string) =>
        (
          (await asAdmin('get', `${duesPath}?institutionId=${institutionId}&sort=${sort}`)).body
            .data as unknown as { id: string }[]
        ).map((row) => row.id);

      expect(await order('dueDate')).toEqual([early.id, late.id, none.id]);
      expect(await order('-dueDate')).toEqual([late.id, early.id, none.id]);
    });

    it('is empty when there are no dues', async () => {
      const { institutionId } = await world();
      const res = await asAdmin('get', `${duesPath}?institutionId=${institutionId}`);
      expect([res.status, res.body.data]).toEqual([200, []]);
      expect(res.body.meta).toMatchObject({ totalItems: 0 });
    });
  });

  describe('PLT-28 to PLT-30 the life of a due', () => {
    it('keeps all three from Owners and Admins and from callers with no token', async () => {
      const { societyId, institutionId, owner } = await world();
      const adminOf = await fixtures.institutionAdmin(societyId, [institutionId]);
      const due = await raised(institutionId);

      for (const token of [owner.token, adminOf.token]) {
        const calls = [
          api('patch', dueAt(due.id), token, { version: 1, studentCount: 5 }),
          api('post', `${dueAt(due.id)}/mark-paid`, token, {
            version: 1,
            paidDate: '2026-05-10',
            paymentMode: 1,
          }),
          api('post', `${dueAt(due.id)}/cancel`, token, { version: 1, reason: 'Raised twice' }),
        ];
        for (const res of await Promise.all(calls)) {
          expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
        }
      }
      const http = request(t.app.getHttpServer());
      expect((await http.patch(dueAt(due.id)).send({ version: 1 })).status).toBe(401);
      expect((await http.post(`${dueAt(due.id)}/mark-paid`).send({})).status).toBe(401);
      expect((await http.post(`${dueAt(due.id)}/cancel`).send({})).status).toBe(401);
      expect((await asAdmin('get', dueAt(due.id))).body.data).toMatchObject({
        dueStatus: 1,
        studentCount: 300,
        version: 1,
      });
    });

    it('answers 404 for an unknown due and for an ID that is not a UUID', async () => {
      for (const id of [missing, 'x']) {
        expect((await edit(id)).status).toBe(404);
        expect((await pay(id)).status).toBe(404);
        expect((await cancel(id)).status).toBe(404);
      }
    });

    describe('PLT-28 edit', () => {
      it('works the amounts out again, moves the version and audits what it was and what it became', async () => {
        const { societyId, institutionId } = await world();
        const due = await raised(institutionId);
        t.clock.set('2031-06-01T04:40:00.000Z');

        const res = await edit(due.id, {
          studentCount: 320,
          studentCountNote: 'Recount in June',
          adjustmentAmount: '-500.00',
          adjustmentNote: 'Opening discount',
          dueDate: '2031-06-30',
        });
        expect([res.status, res.body.code]).toEqual([200, 'OK']);
        expect(res.body.data).toMatchObject({
          id: due.id,
          invoiceNo: due.invoiceNo,
          studentCount: 320,
          studentCountNote: 'Recount in June',
          baseAmount: '16000.00',
          adjustmentAmount: '-500.00',
          adjustmentNote: 'Opening discount',
          totalAmount: '15500.00',
          dueDate: '2031-06-30',
          dueStatus: 1,
          version: 2,
          updatedBy: { id: superAdmin.id },
        });
        expect(res.body.data.updatedAt).not.toBe(res.body.data.createdAt);
        expect((await asAdmin('get', dueAt(due.id))).body.data).toEqual(res.body.data);

        expect(await later(due.id)).toEqual([
          expect.objectContaining({
            action: 'platform_due.edit',
            actor_user_id: superAdmin.id,
            society_id: societyId,
            institution_id: institutionId,
            old_values: expect.objectContaining({
              student_count: 300,
              total_amount: '15000.00',
              due_date: null,
            }),
            new_values: expect.objectContaining({
              student_count: 320,
              total_amount: '15500.00',
              due_date: '2031-06-30',
            }),
          }),
        ]);
      });

      it('leaves what is not named as it was, and clears a note or the due date named null', async () => {
        const { institutionId } = await world();
        const due = await raised(institutionId, {
          adjustmentAmount: '-500.00',
          adjustmentNote: 'Opening discount',
          dueDate: '2026-05-15',
        });
        const unchanged = await edit(due.id, { studentCount: 310, studentCountNote: 'Recount' });
        expect(unchanged.body.data).toMatchObject({
          adjustmentAmount: '-500.00',
          adjustmentNote: 'Opening discount',
          dueDate: '2026-05-15',
          totalAmount: '15000.00',
          version: 2,
        });

        const cleared = await edit(
          due.id,
          {
            adjustmentAmount: '0.00',
            adjustmentNote: null,
            dueDate: null,
            studentCount: 0,
            studentCountNote: null,
          },
          2,
        );
        expect(cleared.body.data).toMatchObject({
          adjustmentAmount: '0.00',
          adjustmentNote: null,
          dueDate: null,
          studentCount: 0,
          studentCountNote: null,
          totalAmount: '0.00',
          version: 3,
        });
      });

      it('takes the rate in force on a new period start, and keeps the frozen rate otherwise', async () => {
        const { institutionId, rateId } = await world();
        const newRate = await setRate(institutionId, '65.00', '2026-10-01');
        const due = await raised(institutionId);

        const sameStart = await edit(due.id, { periodEndDate: '2027-06-30', studentCount: 301 });
        expect(sameStart.body.data).toMatchObject({
          priceRateId: rateId,
          ratePerStudentAmount: '50.00',
          totalAmount: '15050.00',
        });

        const moved = await edit(due.id, { periodStartDate: '2026-10-01' }, 2);
        expect(moved.body.data).toMatchObject({
          priceRateId: newRate,
          ratePerStudentAmount: '65.00',
          baseAmount: '19565.00',
          totalAmount: '19565.00',
          version: 3,
        });

        // A rate set after the edit changes nothing already frozen.
        await setRate(institutionId, '80.00', '2027-04-01');
        expect((await asAdmin('get', dueAt(due.id))).body.data).toMatchObject({
          ratePerStudentAmount: '65.00',
        });
      });

      it('answers 422 NO_RATE_IN_FORCE when no rate starts on or before the new period start, and changes nothing', async () => {
        const { institutionId } = await world();
        const due = await raised(institutionId);
        const res = await edit(due.id, { periodStartDate: '2026-03-31' });
        expect([res.status, res.body.code]).toEqual([422, 'NO_RATE_IN_FORCE']);
        expect(fieldsOf(res)).toEqual([['periodStartDate', 'NO_RATE_IN_FORCE']]);
        expect((await asAdmin('get', dueAt(due.id))).body.data).toMatchObject({
          periodStartDate: '2026-04-01',
          version: 1,
        });
        expect(await later(due.id)).toEqual([]);
      });

      it.each([
        [
          'NOTE_REQUIRED for a new count with no note',
          { studentCount: 310, studentCountNote: null },
          422,
          'NOTE_REQUIRED',
          'studentCountNote',
        ],
        [
          'NOTE_REQUIRED for an adjustment with no note',
          { adjustmentAmount: '-10.00' },
          422,
          'NOTE_REQUIRED',
          'adjustmentNote',
        ],
        [
          'TOTAL_NEGATIVE for a total below zero',
          { adjustmentAmount: '-15000.01', adjustmentNote: 'Too much' },
          422,
          'TOTAL_NEGATIVE',
          'adjustmentAmount',
        ],
        [
          'OUT_OF_RANGE for a period that ends before it starts',
          { periodEndDate: '2026-03-31' },
          400,
          'VALIDATION_FAILED',
          'periodEndDate',
        ],
      ])('answers %s, and changes nothing', async (_what, body, status, code, field) => {
        const { institutionId } = await world();
        const due = await raised(institutionId);
        const res = await edit(due.id, body);
        expect([res.status, res.body.code]).toEqual([status, code]);
        expect(res.body.errors?.map((e) => e.field)).toContain(field);
        expect((await asAdmin('get', dueAt(due.id))).body.data).toMatchObject({
          studentCount: 300,
          totalAmount: '15000.00',
          version: 1,
        });
        expect(await later(due.id)).toEqual([]);
      });

      it('answers 400 OUT_OF_RANGE on the count when the new rate times it is more than the columns hold', async () => {
        const { institutionId } = await world();
        await setRate(institutionId, '99999999.99', '2027-01-01');
        const due = await raised(institutionId);
        const res = await edit(due.id, {
          periodStartDate: '2027-01-01',
          studentCount: 1_000_000,
          studentCountNote: 'x',
        });
        expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
        expect(fieldsOf(res)).toEqual([['studentCount', 'OUT_OF_RANGE']]);
        expect((await asAdmin('get', dueAt(due.id))).body.data.version).toBe(1);
      });

      it('refuses a body that names a field a due cannot change, or leaves out the version', async () => {
        const { institutionId } = await world();
        const due = await raised(institutionId);
        for (const [body, field, code] of [
          [{ version: 1, institutionId }, 'institutionId', 'FIELD_NOT_ALLOWED'],
          [{ version: 1, invoiceNo: 'BNX/1' }, 'invoiceNo', 'FIELD_NOT_ALLOWED'],
          [{ version: 1, totalAmount: '1.00' }, 'totalAmount', 'FIELD_NOT_ALLOWED'],
          [{ version: 1, dueStatus: 2 }, 'dueStatus', 'FIELD_NOT_ALLOWED'],
          [{ version: 1, studentCount: '320' }, 'studentCount', 'INVALID_TYPE'],
          [{ version: 1, studentCount: null }, 'studentCount', 'INVALID_TYPE'],
          [{ version: 1, adjustmentAmount: null }, 'adjustmentAmount', 'INVALID_TYPE'],
          [{ version: 1, dueDate: '15-05-2026' }, 'dueDate', 'INVALID_FORMAT'],
          [{ studentCount: 5 }, 'version', 'INVALID_TYPE'],
        ] as const) {
          const res = await asAdmin('patch', dueAt(due.id), body);
          expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
          expect(fieldsOf(res)).toContainEqual([field, code]);
        }
        expect((await asAdmin('get', dueAt(due.id))).body.data.version).toBe(1);
      });

      it('writes nothing, and keeps the version and the audit trail, when the request changes nothing', async () => {
        const { institutionId } = await world();
        const due = await raised(institutionId, { dueDate: '2026-05-15' });
        const before = (await asAdmin('get', dueAt(due.id))).body.data;

        const res = await edit(due.id, {
          studentCount: 300,
          periodStartDate: '2026-04-01',
          adjustmentAmount: '0.00',
          dueDate: '2026-05-15',
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(before);
        expect(await later(due.id)).toEqual([]);
        expect((await edit(due.id, {})).body.data.version).toBe(1);
      });

      it('sends the Owners no email, whatever is edited', async () => {
        const { institutionId, owner } = await world();
        const due = await raised(institutionId);
        await t.app.get(BackgroundMailer).flush();
        const sent = dueMails(owner.email).length;
        expect(
          (await edit(due.id, { studentCount: 310, studentCountNote: 'Recount' })).status,
        ).toBe(200);
        await t.app.get(BackgroundMailer).flush();
        expect(dueMails(owner.email)).toHaveLength(sent);
      });
    });

    describe('PLT-29 mark paid', () => {
      it('ends the due Paid with the date, mode and reference, and audits it', async () => {
        const { societyId, institutionId } = await world();
        const due = await raised(institutionId);

        const res = await pay(due.id, { paymentReference: 'UTR 4821' });
        expect([res.status, res.body.code]).toEqual([200, 'OK']);
        expect(res.body.data).toMatchObject({
          dueStatus: 2,
          paidDate: '2026-05-10',
          paymentMode: 2,
          paymentReference: 'UTR 4821',
          totalAmount: '15000.00',
          version: 2,
          updatedBy: { id: superAdmin.id },
        });
        expect((await asAdmin('get', dueAt(due.id))).body.data).toEqual(res.body.data);
        expect(await listedIds('dueStatus=2')).toContain(due.id);

        expect(await later(due.id)).toEqual([
          expect.objectContaining({
            action: 'platform_due.mark_paid',
            actor_user_id: superAdmin.id,
            society_id: societyId,
            institution_id: institutionId,
            old_values: expect.objectContaining({ due_status: 1, paid_date: null }),
            new_values: expect.objectContaining({
              due_status: 2,
              paid_date: '2026-05-10',
              payment_mode: 2,
              payment_reference: 'UTR 4821',
            }),
          }),
        ]);
      });

      it('takes any of the four modes, a payment with no reference, and today in India but not tomorrow', async () => {
        const { institutionId } = await world();
        const due = await raised(institutionId);
        const tomorrow = await pay(due.id, { paidDate: '2031-06-02' });
        expect([tomorrow.status, tomorrow.body.code]).toEqual([400, 'VALIDATION_FAILED']);
        expect(fieldsOf(tomorrow)).toEqual([['paidDate', 'OUT_OF_RANGE']]);
        expect((await asAdmin('get', dueAt(due.id))).body.data.dueStatus).toBe(1);

        const today = await pay(due.id, { paidDate: '2031-06-01', paymentMode: 4 });
        expect(today.body.data).toMatchObject({
          paidDate: '2031-06-01',
          paymentMode: 4,
          paymentReference: null,
        });
        for (const mode of [1, 3]) {
          const other = await raised(institutionId);
          expect((await pay(other.id, { paymentMode: mode })).body.data.paymentMode).toBe(mode);
        }
      });

      it('refuses a body with no date or mode, a mode that is not 1 to 4, and a blank reference', async () => {
        const { institutionId } = await world();
        const due = await raised(institutionId);
        for (const [body, field, code] of [
          [{ paidDate: undefined }, 'paidDate', 'INVALID_TYPE'],
          [{ paidDate: '2026-02-30' }, 'paidDate', 'INVALID_FORMAT'],
          [{ paymentMode: undefined }, 'paymentMode', 'INVALID_CODE'],
          [{ paymentMode: 0 }, 'paymentMode', 'INVALID_CODE'],
          [{ paymentMode: 5 }, 'paymentMode', 'INVALID_CODE'],
          [{ paymentMode: '2' }, 'paymentMode', 'INVALID_CODE'],
          [{ paymentReference: '' }, 'paymentReference', 'TOO_SHORT'],
          [{ paymentReference: 'r'.repeat(101) }, 'paymentReference', 'TOO_LONG'],
          [{ dueStatus: 2 }, 'dueStatus', 'FIELD_NOT_ALLOWED'],
        ] as const) {
          const res = await pay(due.id, body);
          expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
          expect(fieldsOf(res)).toContainEqual([field, code]);
        }
        expect((await asAdmin('get', dueAt(due.id))).body.data.dueStatus).toBe(1);
      });

      it('sends the Owners no email', async () => {
        const { institutionId, owner } = await world();
        const due = await raised(institutionId);
        await t.app.get(BackgroundMailer).flush();
        const sent = dueMails(owner.email).length;
        expect((await pay(due.id)).status).toBe(200);
        await t.app.get(BackgroundMailer).flush();
        expect(dueMails(owner.email)).toHaveLength(sent);
      });
    });

    describe('PLT-30 cancel', () => {
      it('ends the due Cancelled with who, when and why, keeps the row and its number, and audits it', async () => {
        const { societyId, institutionId } = await world();
        const due = await raised(institutionId);
        t.clock.set('2031-06-01T04:40:00.000Z');

        const res = await cancel(due.id, { reason: 'Raised twice by mistake' });
        expect([res.status, res.body.code]).toEqual([200, 'OK']);
        expect(res.body.data).toMatchObject({
          invoiceNo: due.invoiceNo,
          dueStatus: 0,
          cancelledAt: '2031-06-01T04:40:00.000Z',
          cancelledBy: { id: superAdmin.id, roleName: 'Super Admin' },
          cancelReason: 'Raised twice by mistake',
          paidDate: null,
          version: 2,
        });
        expect((await asAdmin('get', dueAt(due.id))).body.data).toEqual(res.body.data);
        expect(await listedIds(`institutionId=${institutionId}&dueStatus=0`)).toEqual([due.id]);

        expect(await later(due.id)).toEqual([
          expect.objectContaining({
            action: 'platform_due.cancel',
            actor_user_id: superAdmin.id,
            society_id: societyId,
            institution_id: institutionId,
            old_values: expect.objectContaining({ due_status: 1, cancel_reason: null }),
            new_values: expect.objectContaining({
              due_status: 0,
              cancel_reason: 'Raised twice by mistake',
            }),
          }),
        ]);

        // The number is not given out again.
        const next = await raised(institutionId);
        expect(numberOf(next.invoiceNo)).toBe(numberOf(due.invoiceNo) + 1);
      });

      it('needs a reason of 5 to 500 characters', async () => {
        const { institutionId } = await world();
        const due = await raised(institutionId);
        for (const [body, code] of [
          [{ reason: undefined }, 'INVALID_TYPE'],
          [{ reason: 'Oops' }, 'TOO_SHORT'],
          [{ reason: 'r'.repeat(501) }, 'TOO_LONG'],
        ] as const) {
          const res = await cancel(due.id, body);
          expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
          expect(fieldsOf(res)).toEqual([['reason', code]]);
        }
        expect((await cancel(due.id, { reason: 'r'.repeat(500) })).status).toBe(200);
      });

      it('sends the Owners no email', async () => {
        const { institutionId, owner } = await world();
        const due = await raised(institutionId);
        await t.app.get(BackgroundMailer).flush();
        const sent = dueMails(owner.email).length;
        expect((await cancel(due.id)).status).toBe(200);
        await t.app.get(BackgroundMailer).flush();
        expect(dueMails(owner.email)).toHaveLength(sent);
      });
    });

    describe('the shared rules', () => {
      it('answers 409 VERSION_CONFLICT for a version that is not the current one, before anything else, and changes nothing', async () => {
        const { institutionId } = await world();
        const due = await raised(institutionId);
        expect((await edit(due.id, { studentCount: 301, studentCountNote: 'x' })).status).toBe(200);

        for (const res of [
          await edit(due.id, { studentCount: 302, studentCountNote: 'x' }, 1),
          await pay(due.id, {}, 1),
          await cancel(due.id, {}, 1),
          await edit(due.id, { studentCount: 302, studentCountNote: 'x' }, 7),
        ]) {
          expect([res.status, res.body.code]).toEqual([409, 'VERSION_CONFLICT']);
        }
        expect((await asAdmin('get', dueAt(due.id))).body.data).toMatchObject({
          studentCount: 301,
          dueStatus: 1,
          version: 2,
        });
      });

      it('makes Paid and Cancelled final: 409 INVALID_STATE for an edit, a payment or a cancellation, and VERSION_CONFLICT still comes first', async () => {
        const { institutionId } = await world();
        const paid = await raised(institutionId);
        const cancelled = await raised(institutionId);
        expect((await pay(paid.id)).status).toBe(200);
        expect((await cancel(cancelled.id)).status).toBe(200);

        for (const id of [paid.id, cancelled.id]) {
          for (const res of [
            await edit(id, { studentCount: 5, studentCountNote: 'x' }, 2),
            await pay(id, {}, 2),
            await cancel(id, {}, 2),
          ]) {
            expect([res.status, res.body.code]).toEqual([409, 'INVALID_STATE']);
          }
          expect((await edit(id, {}, 1)).body.code).toBe('VERSION_CONFLICT');
          expect((await asAdmin('get', dueAt(id))).body.data.version).toBe(2);
          expect(await later(id)).toHaveLength(1);
        }
      });

      it('lets one of two requests at once win, the other is told to reload, and the audit trail has one entry', async () => {
        const { institutionId } = await world();
        const due = await raised(institutionId);
        const results = await Promise.all([pay(due.id), cancel(due.id)]);
        expect(results.map((res) => res.status).toSorted()).toEqual([200, 409]);
        const loser = results.find((res) => res.status === 409)!;
        expect(loser.body.code).toBe('VERSION_CONFLICT');
        expect((await asAdmin('get', dueAt(due.id))).body.data.version).toBe(2);
        expect(await later(due.id)).toHaveLength(1);
      });
    });
  });

  describe('the table', () => {
    const insertDue = (
      tenant: { roleCode: number; personId?: string },
      ids: { societyId: string; institutionId: string; rateId: string },
      overrides: Record<string, unknown> = {},
    ) => {
      const row: Record<string, unknown> = {
        society_id: ids.societyId,
        institution_id: ids.institutionId,
        invoice_no: `T/${newId().slice(-12)}`,
        period_start_date: '2026-04-01',
        period_end_date: '2027-03-31',
        student_count_auto: 0,
        student_count: 10,
        student_count_note: 'Counted',
        price_rate_id: ids.rateId,
        rate_per_student_amount: '50.00',
        base_amount: '500.00',
        adjustment_amount: '0.00',
        adjustment_note: null,
        total_amount: '500.00',
        created_by: superAdmin.id,
        ...overrides,
      };
      return database.transaction(
        { ...tenant, societyId: ids.societyId, institutionIds: [ids.institutionId] },
        (tx) =>
          sql`insert into platform_dues (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
            values (${sql.join(Object.values(row).map((value) => sql`${value}`))})`.execute(tx),
      );
    };
    const asSuperAdmin = { roleCode: 1, personId: superAdmin.id };

    it('shows a due to Super Admin and to the Owners of its Society only: an Admin, another Society’s Owner and a request with no tenant read none', async () => {
      const { societyId, institutionId } = await world();
      await raised(institutionId);
      expect((await read({ roleCode: 1, personId: superAdmin.id })).rows).toHaveLength(1);
      expect((await read({ societyId, roleCode: 2 })).rows).toHaveLength(1);
      expect((await read({ societyId: missing, roleCode: 2 })).rows).toEqual([]);
      expect(
        (await read({ societyId, roleCode: 3, institutionIds: [institutionId] })).rows,
      ).toEqual([]);
      expect((await read({})).rows).toEqual([]);
    });

    it('lets nobody but a Super Admin insert a due, whatever Society and Institution they name', async () => {
      const ids = await world();
      await expect(insertDue({ roleCode: 2 }, ids)).rejects.toThrow(/row-level security/);
      await expect(insertDue({ roleCode: 3 }, ids)).rejects.toThrow(/row-level security/);
      await expect(insertDue({ roleCode: 4 }, ids)).rejects.toThrow(/row-level security/);
      await expect(insertDue(asSuperAdmin, ids)).resolves.toBeDefined();
    });

    it('keeps every due: the app role can neither delete nor truncate one', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      for (const statement of [
        sql`delete from platform_dues where id = ${due.id}`,
        sql`truncate platform_dues`,
      ]) {
        await expect(
          database.transaction(asSuperAdmin, (tx) => statement.execute(tx)),
        ).rejects.toThrow(/permission denied/);
      }
    });

    it.each([
      ['the invoice number', sql`invoice_no = 'BNX/FY2031-32/9999'`],
      ['the Institution', sql`institution_id = society_id`],
      ['the Society', sql`society_id = institution_id`],
      ['the automatic count', sql`student_count_auto = 5`],
      ['the author', sql`created_by = null`],
      ['the version', sql`version = 9`],
    ])('lets the app role change what the lifecycle changes, but never %s', async (_what, set) => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      await expect(
        database.transaction(asSuperAdmin, (tx) =>
          sql`update platform_dues set ${set} where id = ${due.id}`.execute(tx),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('refuses any change to a Paid or a Cancelled due, even written directly by a Super Admin', async () => {
      const { institutionId } = await world();
      const paid = await raised(institutionId);
      const cancelled = await raised(institutionId);
      expect((await pay(paid.id)).status).toBe(200);
      expect((await cancel(cancelled.id)).status).toBe(200);

      for (const [id, word] of [
        [paid.id, 'Paid'],
        [cancelled.id, 'Cancelled'],
      ] as const) {
        await expect(
          database.transaction(asSuperAdmin, (tx) =>
            sql`update platform_dues set due_date = '2031-01-01' where id = ${id}`.execute(tx),
          ),
        ).rejects.toThrow(new RegExp(`A ${word} due cannot be changed`));
      }
    });

    it('lets only a Super Admin change a due: for anyone else no row is there to change, with or without a filter', async () => {
      const { societyId, institutionId } = await world();
      const due = await raised(institutionId);
      for (const tenant of [
        { roleCode: 2, societyId },
        { roleCode: 3, societyId, institutionIds: [institutionId] },
        {},
      ]) {
        for (const statement of [
          sql`update platform_dues set due_date = '2031-01-01' where id = ${due.id}`,
          sql`update platform_dues set due_date = '2031-01-01'`,
        ]) {
          const result = await database.transaction(tenant, (tx) => statement.execute(tx));
          expect(result.numAffectedRows).toBe(0n);
        }
      }
      expect((await asAdmin('get', dueAt(due.id))).body.data).toMatchObject({
        dueDate: null,
        version: 1,
      });
    });

    it('keeps the frozen rate whole when written directly: its amount must be the one on the rate row, and the rate must be the Institution’s own', async () => {
      const ids = await world();
      const other = await world();
      const due = await raised(ids.institutionId);
      await expect(
        database.transaction(asSuperAdmin, (tx) =>
          sql`update platform_dues set rate_per_student_amount = '51.00', base_amount = '15300.00',
            total_amount = '15300.00' where id = ${due.id}`.execute(tx),
        ),
      ).rejects.toThrow(/fk_platform_dues_rate/);
      await expect(
        database.transaction(asSuperAdmin, (tx) =>
          sql`update platform_dues set price_rate_id = ${other.rateId} where id = ${due.id}`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/fk_platform_dues_rate/);
    });

    it.each([
      [
        'an amount that is not the count times the rate',
        { base_amount: '501.00', total_amount: '501.00' },
        /ck_platform_dues_base/,
      ],
      [
        'a total that is not the base plus the adjustment',
        { total_amount: '499.00' },
        /ck_platform_dues_total/,
      ],
      [
        'a negative total',
        { adjustment_amount: '-600.00', adjustment_note: 'x', total_amount: '-100.00' },
        /ck_platform_dues_total/,
      ],
      [
        'a changed count with no note',
        { student_count: 10, student_count_auto: 9, student_count_note: null },
        /ck_platform_dues_count_note/,
      ],
      ['a blank count note', { student_count_note: '  ' }, /ck_platform_dues_count_note/],
      [
        'an adjustment with no note',
        { adjustment_amount: '5.00', total_amount: '505.00' },
        /ck_platform_dues_adjustment_note/,
      ],
      [
        'a period that ends before it starts',
        { period_end_date: '2026-03-31' },
        /ck_platform_dues_period/,
      ],
      [
        'a negative count',
        { student_count: -1, base_amount: '-50.00', total_amount: '-50.00' },
        /ck_platform_dues_(counts|total)/,
      ],
      [
        'a negative count whose total still adds up',
        {
          student_count: -1,
          base_amount: '-50.00',
          adjustment_amount: '50.00',
          adjustment_note: 'Offsets the count',
          total_amount: '0.00',
        },
        /ck_platform_dues_counts/,
      ],
      ['a status that is not 0, 1 or 2', { due_status: 3 }, /ck_platform_dues_status/],
      ['a payment mode that is not 1 to 4', { payment_mode: 5 }, /ck_platform_dues_mode/],
      ['a Paid due with no paid date', { due_status: 2, payment_mode: 1 }, /ck_platform_dues_paid/],
      [
        'a Paid due with no payment mode',
        { due_status: 2, paid_date: '2026-06-01' },
        /ck_platform_dues_paid/,
      ],
      [
        'a payment reference on a due that is not Paid',
        { payment_reference: 'UTR123' },
        /ck_platform_dues_paid/,
      ],
      ['a Cancelled due that was never cancelled', { due_status: 0 }, /ck_platform_dues_cancelled/],
      [
        'a cancellation on a due that is not Cancelled',
        { cancelled_at: '2026-06-01T00:00:00Z', cancelled_by: superAdmin.id, cancel_reason: 'x' },
        /ck_platform_dues_cancelled/,
      ],
      [
        'a cancel reason of spaces',
        {
          due_status: 0,
          cancelled_at: '2026-06-01T00:00:00Z',
          cancelled_by: superAdmin.id,
          cancel_reason: '   ',
        },
        /ck_platform_dues_cancelled/,
      ],
      [
        'a count note of spaces when the count is the automatic one',
        { student_count: 0, base_amount: '0.00', total_amount: '0.00', student_count_note: '  ' },
        /ck_platform_dues_count_note/,
      ],
      [
        'an adjustment note of spaces when there is no adjustment',
        { adjustment_note: '  ' },
        /ck_platform_dues_adjustment_note/,
      ],
    ])('refuses %s even when written directly', async (_what, overrides, constraint) => {
      const ids = await world();
      await expect(insertDue(asSuperAdmin, ids, overrides)).rejects.toThrow(constraint);
    });

    it('refuses a second due with the same invoice number, and a rate that is another Institution’s', async () => {
      const ids = await world();
      const due = await raised(ids.institutionId);
      await expect(insertDue(asSuperAdmin, ids, { invoice_no: due.invoiceNo })).rejects.toThrow(
        /uq_platform_dues_invoice_no/,
      );

      const other = await world();
      await expect(insertDue(asSuperAdmin, { ...ids, rateId: other.rateId })).rejects.toThrow(
        /fk_platform_dues_rate/,
      );
      await expect(insertDue(asSuperAdmin, { ...ids, societyId: other.societyId })).rejects.toThrow(
        /fk_platform_dues_institution/,
      );
    });
  });
});
