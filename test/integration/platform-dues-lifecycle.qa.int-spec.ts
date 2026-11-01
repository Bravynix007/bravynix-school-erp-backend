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

/** A day in a financial year no other test uses, so the invoice counter starts from 1 here. */
const TEST_DAY = '2035-06-01T04:30:00.000Z';
const TEST_YEAR = 'FY2035-36';

type Method = 'get' | 'post' | 'patch' | 'delete';

const duesPath = '/v1/platform/dues';
const dueAt = (id: string) => `${duesPath}/${id}`;

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

/** The audit fields whose value differs between before and after. */
const changed = (entry: {
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}) =>
  Object.keys(entry.new_values!)
    .filter((k) => JSON.stringify(entry.new_values![k]) !== JSON.stringify(entry.old_values![k]))
    .toSorted();

describe('QA: PLT-28 to PLT-30 due lifecycle, adversarial (API design 10.22, DDD 9.10)', () => {
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

  /**
   * Oldest first. The audit time comes from the fixed test clock, so a raise and the changes after it share
   * one created_at; the IDs are UUIDv7 and keep the order they were written in.
   */
  const audit = async (entityId: string) =>
    (
      await readAuditRows<{
        id: string;
        action: string;
        actor_user_id: string;
        society_id: string;
        institution_id: string | null;
        old_values: Record<string, unknown> | null;
        new_values: Record<string, unknown> | null;
      }>(ownerDb, sql`entity_id = ${entityId}`)
    ).toSorted((a, b) => (a.id < b.id ? -1 : 1));

  /** The audit entries after the raise, oldest first. */
  const later = async (id: string) => (await audit(id)).slice(1);

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

  const asSuperAdmin = { roleCode: 1, personId: superAdmin.id };
  const current = async (id: string) => (await asAdmin('get', dueAt(id))).body.data;
  /** As the table owner, which skips the column grants; RLS is forced, so it reads as Super Admin. */
  const ownerUpdate = (id: string, set: ReturnType<typeof sql>) =>
    ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      const res = await sql`update platform_dues set ${set} where id = ${id}`.execute(tx);
      if (res.numAffectedRows !== 1n) throw new Error(`QA: ${String(res.numAffectedRows)} rows`);
      return res;
    });

  describe('L1 an edit that changes nothing', () => {
    it.each([
      ['the same adjustment written as -0.00', { adjustmentAmount: '-0.00' }],
      ['the same adjustment with leading zeros', { adjustmentAmount: '000.00' }],
      [
        'the same note with spaces around it',
        { studentCountNote: '  Counted from the register  ' },
      ],
      ['the same period start', { periodStartDate: '2026-04-01' }],
      [
        'every field as it already is',
        {
          periodStartDate: '2026-04-01',
          periodEndDate: '2027-03-31',
          studentCount: 300,
          studentCountNote: 'Counted from the register',
          adjustmentAmount: '0.00',
          adjustmentNote: null,
          dueDate: null,
        },
      ],
    ])('keeps the version and writes no audit entry for %s', async (_what, body) => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      const res = await edit(due.id, body);
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(1);
      expect(await later(due.id)).toHaveLength(0);
    });
  });

  describe('L2 the edit merge', () => {
    it('refuses null for the count, the period and the adjustment, and a version that is not a positive whole number', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      for (const body of [
        { studentCount: null },
        { periodStartDate: null },
        { periodEndDate: null },
        { adjustmentAmount: null },
      ]) {
        const res = await edit(due.id, body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      }
      for (const version of ['1', 0, -1, 1.5, null]) {
        const res = await asAdmin('patch', dueAt(due.id), { version, dueDate: '2035-07-01' });
        expect([String(version), res.status]).toEqual([String(version), 400]);
      }
      expect((await current(due.id)).version).toBe(1);
      expect(await later(due.id)).toHaveLength(0);
    });

    it('clearing the count note while the count still differs from the automatic one is NOTE_REQUIRED, and nothing changes', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      const res = await edit(due.id, { studentCountNote: null });
      expect([res.status, res.body.code]).toEqual([422, 'NOTE_REQUIRED']);
      const ok = await edit(due.id, { studentCount: 0, studentCountNote: null });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        studentCount: 0,
        studentCountNote: null,
        totalAmount: '0.00',
        version: 2,
      });
    });

    it('an adjustment that pushes the total past the column is 400 on adjustmentAmount, and one that makes it negative is TOTAL_NEGATIVE', async () => {
      const { institutionId } = await world();
      await setRate(institutionId, '99999999.99', '2027-01-01');
      const due = await raised(institutionId, { periodStartDate: '2027-01-01', studentCount: 100 });
      const over = await edit(due.id, { adjustmentAmount: '1.00', adjustmentNote: 'x' });
      expect(over.status).toBe(400);
      expect(over.body.errors).toContainEqual(
        expect.objectContaining({ field: 'adjustmentAmount', code: 'OUT_OF_RANGE' }),
      );
      const below = await edit(due.id, {
        studentCount: 0,
        adjustmentAmount: '-0.01',
        adjustmentNote: 'x',
      });
      expect([below.status, below.body.code]).toEqual([422, 'TOTAL_NEGATIVE']);
      expect((await current(due.id)).version).toBe(1);
    });

    it('moving the start away and back takes the rate in force each time, and the version counts every real change', async () => {
      const { institutionId, rateId } = await world();
      const newer = await setRate(institutionId, '65.00', '2026-10-01');
      const due = await raised(institutionId);
      const moved = await edit(due.id, { periodStartDate: '2026-10-01' });
      expect(moved.body.data).toMatchObject({
        priceRateId: newer,
        ratePerStudentAmount: '65.00',
        totalAmount: '19500.00',
        version: 2,
      });
      const back = await edit(due.id, { periodStartDate: '2026-04-01' }, 2);
      expect(back.body.data).toMatchObject({
        priceRateId: rateId,
        ratePerStudentAmount: '50.00',
        totalAmount: '15000.00',
        version: 3,
      });
      const early = await edit(due.id, { periodStartDate: '2026-03-31' }, 3);
      expect([early.status, early.body.code]).toEqual([422, 'NO_RATE_IN_FORCE']);
      expect(await later(due.id)).toHaveLength(2);
    });

    it('moving only the end before the start is 400 on periodEndDate', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      const res = await edit(due.id, { periodEndDate: '2026-03-31' });
      expect(res.status).toBe(400);
      expect(res.body.errors).toContainEqual(
        expect.objectContaining({ field: 'periodEndDate', code: 'OUT_OF_RANGE' }),
      );
    });
  });

  describe('L3 requests at once', () => {
    it('lets exactly one of an edit, a payment and a cancellation sent together win, ten times over', async () => {
      const { institutionId } = await world();
      for (let round = 0; round < 10; round += 1) {
        const due = await raised(institutionId);
        const results = await Promise.all([
          edit(due.id, { dueDate: '2035-07-01' }),
          pay(due.id),
          cancel(due.id),
        ]);
        const winners = results.filter((res) => res.status === 200);
        expect(winners).toHaveLength(1);
        for (const loser of results.filter((res) => res.status !== 200)) {
          expect([loser.status, loser.body.code]).toEqual([409, 'VERSION_CONFLICT']);
        }
        const now = await current(due.id);
        expect(now.version).toBe(2);
        expect(await later(due.id)).toHaveLength(1);
        expect(now.dueStatus).toBe(winners[0]!.body.data.dueStatus);
      }
    }, 60_000);

    it('two payments at once with the same version: one Paid, one VERSION_CONFLICT, and the first payment’s fields stay', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      const [a, b] = await Promise.all([
        pay(due.id, { paymentMode: 1, paymentReference: 'A' }),
        pay(due.id, { paymentMode: 3, paymentReference: 'B' }),
      ]);
      expect([a!.status, b!.status].toSorted()).toEqual([200, 409]);
      const won = a!.status === 200 ? a! : b!;
      expect(await current(due.id)).toMatchObject({
        dueStatus: 2,
        paymentReference: won.body.data.paymentReference,
      });
    });
  });

  describe('L4 final states', () => {
    it('a Paid or Cancelled due cannot go back to Due, even for the table owner', async () => {
      const { institutionId } = await world();
      const paid = await raised(institutionId);
      const cancelled = await raised(institutionId);
      expect((await pay(paid.id)).status).toBe(200);
      expect((await cancel(cancelled.id)).status).toBe(200);
      await expect(
        ownerUpdate(paid.id, sql`due_status = 1, paid_date = null, payment_mode = null`),
      ).rejects.toThrow(/A Paid due cannot be changed/);
      await expect(
        ownerUpdate(
          cancelled.id,
          sql`due_status = 1, cancelled_at = null, cancelled_by = null, cancel_reason = null`,
        ),
      ).rejects.toThrow(/A Cancelled due cannot be changed/);
      await expect(ownerUpdate(paid.id, sql`total_amount = 1`)).rejects.toThrow(
        /cannot be changed/,
      );
      expect(await current(paid.id)).toMatchObject({ dueStatus: 2, version: 2 });
      expect(await current(cancelled.id)).toMatchObject({ dueStatus: 0, version: 2 });
    });

    it('a Paid due refuses the same payment again and a cancellation at its current version, with INVALID_STATE', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      expect((await pay(due.id)).status).toBe(200);
      for (const res of [
        await pay(due.id, {}, 2),
        await cancel(due.id, {}, 2),
        await edit(due.id, {}, 2),
      ]) {
        expect([res.status, res.body.code]).toEqual([409, 'INVALID_STATE']);
      }
    });

    it('a cancelled number is never given out again', async () => {
      const { institutionId } = await world();
      const one = await raised(institutionId);
      expect((await cancel(one.id)).status).toBe(200);
      const two = await raised(institutionId);
      expect(numberOf(two.invoiceNo)).toBe(numberOf(one.invoiceNo) + 1);
    });

    it('the app role cannot write a Due row straight to Paid without its payment fields', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      await expect(
        database.transaction(asSuperAdmin, (tx) =>
          sql`update platform_dues set due_status = 2 where id = ${due.id}`.execute(tx),
        ),
      ).rejects.toThrow();
      await expect(
        database.transaction(asSuperAdmin, (tx) =>
          sql`update platform_dues set due_status = 0 where id = ${due.id}`.execute(tx),
        ),
      ).rejects.toThrow();
      await expect(
        database.transaction(asSuperAdmin, (tx) =>
          sql`update platform_dues set due_status = 7 where id = ${due.id}`.execute(tx),
        ),
      ).rejects.toThrow();
      expect((await current(due.id)).dueStatus).toBe(1);
    });
  });

  describe('L5 paid date in India', () => {
    it('turns “tomorrow” into “today” at exactly 18:30 UTC', async () => {
      const { institutionId } = await world();
      const a = await raised(institutionId);
      const b = await raised(institutionId);
      t.clock.set('2035-06-01T18:29:59.999Z');
      admin = await signInAdmin();
      const early = await pay(a.id, { paidDate: '2035-06-02' });
      expect([early.status, early.body.errors?.[0]?.field]).toEqual([400, 'paidDate']);
      expect((await pay(a.id, { paidDate: '2035-06-01' })).status).toBe(200);
      t.clock.set('2035-06-01T18:30:00.000Z');
      admin = await signInAdmin();
      expect((await pay(b.id, { paidDate: '2035-06-02' })).status).toBe(200);
    });

    it('refuses a date that does not exist, a mode sent as text, and a NUL in the reference', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      for (const body of [
        { paidDate: '2035-02-29' },
        { paidDate: '2035-6-1' },
        { paymentMode: '2' },
        { paymentMode: 0 },
        { paymentReference: 'ref\u0000' },
        { paymentReference: 'r'.repeat(101) },
      ]) {
        const res = await pay(due.id, body);
        expect([JSON.stringify(body).slice(0, 40), res.status]).toEqual([
          JSON.stringify(body).slice(0, 40),
          400,
        ]);
      }
      expect((await current(due.id)).dueStatus).toBe(1);
    });
  });

  describe('L6 an Institution or Society that has closed', () => {
    it('still takes a payment or a cancellation for a due of a deactivated Institution, and says what an edit does', async () => {
      const { institutionId, owner } = await world();
      const a = await raised(institutionId);
      const b = await raised(institutionId);
      const c = await raised(institutionId);
      await api('delete', `/v1/institutions/${institutionId}`, owner.token);
      expect((await pay(a.id)).status).toBe(200);
      expect((await cancel(b.id)).status).toBe(200);
      const edited = await edit(c.id, { dueDate: '2035-07-01' });
      console.log(
        'QA-L6 edit on a deactivated Institution:',
        edited.status,
        edited.body.code ?? '',
      );
      expect([200, 409]).toContain(edited.status);
    });
  });

  describe('L7 who may call', () => {
    it('leaves a due untouched after an Owner’s and an Admin’s edit, payment and cancellation, and audits none', async () => {
      const { societyId, institutionId, owner } = await world();
      const adminOf = await fixtures.institutionAdmin(societyId, [institutionId]);
      const due = await raised(institutionId);
      for (const token of [owner.token, adminOf.token]) {
        for (const res of await Promise.all([
          api('patch', dueAt(due.id), token, { version: 1, dueDate: '2035-07-01' }),
          api('post', `${dueAt(due.id)}/mark-paid`, token, {
            version: 1,
            paidDate: '2035-05-10',
            paymentMode: 2,
          }),
          api('post', `${dueAt(due.id)}/cancel`, token, { version: 1, reason: 'Raised twice' }),
        ])) {
          expect(res.status).toBe(403);
        }
      }
      expect(await current(due.id)).toMatchObject({ version: 1, dueStatus: 1, dueDate: null });
      expect(await later(due.id)).toHaveLength(0);
    });
  });

  describe('L8 audit', () => {
    it('records each change with the Society, the Institution, the actor and before and after that differ only where the change was', async () => {
      const { societyId, institutionId } = await world();
      const due = await raised(institutionId);
      expect((await edit(due.id, { dueDate: '2035-07-01' })).status).toBe(200);
      const second = await signInAdmin(personaByKey('SA2').id);
      const paid = await api('post', `${dueAt(due.id)}/mark-paid`, second, {
        version: 2,
        paidDate: '2035-05-10',
        paymentMode: 4,
        paymentReference: 'CHQ 1',
      });
      expect(paid.status).toBe(200);
      expect(paid.body.data.updatedBy).toMatchObject({ id: personaByKey('SA2').id });
      const [e, p] = await later(due.id);
      expect(e).toMatchObject({
        action: 'platform_due.edit',
        society_id: societyId,
        institution_id: institutionId,
        actor_user_id: superAdmin.id,
      });
      expect(p).toMatchObject({
        action: 'platform_due.mark_paid',
        society_id: societyId,
        institution_id: institutionId,
        actor_user_id: personaByKey('SA2').id,
      });
      expect(changed(e!)).toEqual(['due_date']);
      expect(changed(p!)).toEqual(['due_status', 'paid_date', 'payment_mode', 'payment_reference']);
    });
  });

  describe('L9 PLT-25 sort by due date', () => {
    it('puts dues with no due date last in both directions', async () => {
      const { institutionId } = await world();
      const late = await raised(institutionId, { dueDate: '2035-09-01' });
      const none = await raised(institutionId);
      const early = await raised(institutionId, { dueDate: '2035-07-01' });
      const order = async (sort: string) =>
        (
          (await asAdmin('get', `${duesPath}?institutionId=${institutionId}&sort=${sort}`)).body
            .data as unknown as { id: string }[]
        ).map((row) => row.id);
      expect(await order('dueDate')).toEqual([early.id, late.id, none.id]);
      expect(await order('-dueDate')).toEqual([late.id, early.id, none.id]);
    });
  });
});
