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
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');

/** A day in a financial year no other test uses, so the invoice counter starts from 1 here. */
const TEST_DAY = '2033-06-01T04:30:00.000Z';
const TEST_YEAR = 'FY2033-34';

type Method = 'get' | 'post' | 'patch' | 'delete';

const duesPath = '/v1/platform/dues';
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

describe('QA: PLT-24 to PLT-27 platform dues, adversarial (PRD 9.2, 9.3, API design 10.22)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
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

  /** The due notices an address was sent; its sign-in codes are not counted. */
  const dueMails = (address: string) =>
    t.email.all().filter((mail) => mail.to === address && mail.template === 'platform-due-raised');

  const dueRows = async (institutionId: string) =>
    (
      await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        return sql<{ n: number }>`select count(*)::int as n from platform_dues
          where institution_id = ${institutionId}`.execute(tx);
      })
    ).rows[0]!.n;

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

  /** Raw people this file adds next to the fixtures: a second Owner seat, and the like. */
  const extras: string[] = [];
  const extraOwner = async (societyId: string, seatNo: number) => {
    const person = newId();
    const email = `${person}@two-worlds.test`;
    await sql`insert into users (id, email) values (${person}, ${email})`.execute(ownerDb);
    await sql`insert into role_assignments (user_id, role_code, society_id, seat_no)
      values (${person}, 2, ${societyId}, ${seatNo})`.execute(ownerDb);
    extras.push(person);
    return { person, email };
  };
  const flush = () => t.app.get(BackgroundMailer).flush();
  const clearYear = (periodKey: string) =>
    ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      await sql`delete from number_sequences where sequence_type = 3 and period_key = ${periodKey}`.execute(
        tx,
      );
    });
  const idempotencyRows = async () =>
    (
      await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        return sql<{ n: number }>`select count(*)::int as n from idempotency_keys`.execute(tx);
      })
    ).rows[0]!.n;

  afterEach(async () => {
    for (const person of extras.splice(0)) {
      await sql`delete from role_assignments where user_id = ${person}`.execute(ownerDb);
      await sql`delete from users where id = ${person}`.execute(ownerDb);
    }
  });

  describe('Q1 amounts at the edges', () => {
    it('takes an adjustment of -0.00 as no adjustment: no note needed, and it is stored as 0.00', async () => {
      const { institutionId } = await world();
      const res = await raise(dueBody(institutionId, { adjustmentAmount: '-0.00' }));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        adjustmentAmount: '0.00',
        baseAmount: '15000.00',
        totalAmount: '15000.00',
      });
    });

    it('holds a total of exactly the largest amount, emails it in Indian grouping, and refuses one paisa more on adjustmentAmount', async () => {
      const { institutionId, owner } = await world();
      await setRate(institutionId, '99999999.99', '2027-01-01');
      const body = { periodStartDate: '2027-01-01', studentCount: 100 };
      const max = await raise(
        dueBody(institutionId, { ...body, adjustmentAmount: '0.99', adjustmentNote: 'Rounding' }),
      );
      expect(max.status).toBe(201);
      expect(max.body.data).toMatchObject({
        baseAmount: '9999999999.00',
        totalAmount: '9999999999.99',
      });
      await flush();
      expect(t.email.latest(owner.email, 'platform-due-raised')!.text).toContain(
        'Amount: ₹9,99,99,99,999.99',
      );

      const over = await raise(
        dueBody(institutionId, { ...body, adjustmentAmount: '1.00', adjustmentNote: 'Rounding' }),
      );
      expect([over.status, over.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(over.body.errors).toContainEqual(
        expect.objectContaining({ field: 'adjustmentAmount', code: 'OUT_OF_RANGE' }),
      );
      expect(await dueRows(institutionId)).toBe(1);
    });

    it('accepts the largest signed adjustment format and refuses nine whole digits, a plus sign, or spaces inside', async () => {
      const { institutionId } = await world();
      const ok = await raise(
        dueBody(institutionId, {
          studentCount: 1_000_000,
          adjustmentAmount: '-49999999.99',
          adjustmentNote: 'Discount',
        }),
      );
      expect(ok.status).toBe(201);
      expect(ok.body.data.totalAmount).toBe('0.01');
      for (const adjustmentAmount of ['-100000000.00', '+5.00', '5 .00', '1e3', '٥.٠٠']) {
        const res = await raise(
          dueBody(institutionId, { adjustmentAmount, adjustmentNote: 'Discount' }),
        );
        expect([adjustmentAmount, res.status]).toEqual([adjustmentAmount, 400]);
      }
    });

    it('lets a count of zero and no adjustment make a due of 0.00 without notes', async () => {
      const { institutionId } = await world();
      const res = await raise(dueBody(institutionId, { studentCount: 0, studentCountNote: null }));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ baseAmount: '0.00', totalAmount: '0.00' });
    });
  });

  describe('Q2 notes', () => {
    it('refuses a note of spaces only, a NUL, and 501 characters; keeps 500 characters exactly', async () => {
      const { institutionId } = await world();
      const spaces = await raise(dueBody(institutionId, { studentCountNote: '    ' }));
      expect(spaces.status).toBe(400);
      expect(spaces.body.errors).toContainEqual(
        expect.objectContaining({ field: 'studentCountNote' }),
      );
      const nul = await raise(dueBody(institutionId, { studentCountNote: 'Counted\u0000' }));
      expect(nul.status).toBe(400);
      const long = await raise(dueBody(institutionId, { studentCountNote: 'n'.repeat(501) }));
      expect(long.status).toBe(400);
      const exact = await raise(dueBody(institutionId, { studentCountNote: 'n'.repeat(500) }));
      expect(exact.status).toBe(201);
      expect(exact.body.data.studentCountNote).toHaveLength(500);
      expect(await dueRows(institutionId)).toBe(1);
    });

    it('checks the notes before the amounts: missing notes on a total that would go negative is NOTE_REQUIRED, and takes no number', async () => {
      const { institutionId } = await world();
      const res = await raise(
        dueBody(institutionId, { studentCountNote: null, adjustmentAmount: '-99999.00' }),
      );
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('NOTE_REQUIRED');
      expect((await raised(institutionId)).invoiceNo).toBe(`BNX/${TEST_YEAR}/0001`);
    });
  });

  describe('Q3 the rate copied onto the due', () => {
    it('uses the rate of the period start even when that rate starts after today', async () => {
      const { institutionId, rateId } = await world();
      const future = await setRate(institutionId, '80.00', '2034-01-01');
      const before = await raised(institutionId, {
        periodStartDate: '2033-12-31',
        periodEndDate: '2034-12-31',
      });
      const after = await raised(institutionId, {
        periodStartDate: '2034-01-01',
        periodEndDate: '2034-12-31',
      });
      const [one, two] = await Promise.all(
        [before.id, after.id].map((id) => asAdmin('get', `${duesPath}/${id}`)),
      );
      expect(one!.body.data).toMatchObject({ priceRateId: rateId, ratePerStudentAmount: '50.00' });
      expect(two!.body.data).toMatchObject({ priceRateId: future, ratePerStudentAmount: '80.00' });
    });

    it('never borrows another Institution’s rate: a sister Institution with no rate is NO_RATE_IN_FORCE', async () => {
      const { societyId } = await world();
      const sister = await institution(societyId);
      const res = await raise(dueBody(sister.id));
      expect([res.status, res.body.code]).toEqual([422, 'NO_RATE_IN_FORCE']);
      const quote = await asAdmin(
        'get',
        `${quotePath(sister.id)}?periodStartDate=2026-04-01&periodEndDate=2027-03-31`,
      );
      expect(quote.body.data).toMatchObject({ priceRateId: null, baseAmount: null });
    });

    it('keeps the frozen rate and amounts after a newer rate for the same start date is set', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId, {
        periodStartDate: '2027-04-01',
        periodEndDate: '2028-03-31',
      });
      const again = await asAdmin(
        'post',
        `/v1/platform/institutions/${institutionId}/price-rates`,
        {
          ratePerStudentAmount: '70.00',
          effectiveFromDate: '2027-04-01',
        },
      );
      // B1 lets a second rate start on the same day; the due keeps what it froze.
      expect(again.status).toBe(201);
      const res = await asAdmin('get', `${duesPath}/${due.id}`);
      expect(res.body.data).toMatchObject({
        ratePerStudentAmount: '50.00',
        totalAmount: '15000.00',
      });
    });
  });

  describe('Q4 the same request again', () => {
    it('replays the stored 201 after the Institution is deactivated, and a new key then gets INVALID_STATE', async () => {
      const { institutionId, owner } = await world();
      const key = newId();
      const one = await raise(dueBody(institutionId), key);
      await flush();
      await api('delete', `/v1/institutions/${institutionId}`, owner.token);
      const again = await raise(dueBody(institutionId), key);
      await flush();
      expect([again.status, again.headers['idempotent-replayed']]).toEqual([201, 'true']);
      expect(again.body.data).toEqual(one.body.data);
      expect(dueMails(owner.email)).toHaveLength(1);
      const fresh = await raise(dueBody(institutionId));
      expect([fresh.status, fresh.body.code]).toEqual([409, 'INVALID_STATE']);
    });

    it('burns a key on a stored refusal: the corrected body under the same key is IDEMPOTENCY_KEY_REUSED, a new key succeeds', async () => {
      const { institutionId } = await world();
      const key = newId();
      const refused = await raise(dueBody(institutionId, { studentCountNote: null }), key);
      expect(refused.body.code).toBe('NOTE_REQUIRED');
      const fixed = await raise(dueBody(institutionId), key);
      expect([fixed.status, fixed.body.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
      expect((await raise(dueBody(institutionId))).status).toBe(201);
      expect(await dueRows(institutionId)).toBe(1);
    });

    it('treats a body with the same fields in another order as the same request', async () => {
      const { institutionId } = await world();
      const key = newId();
      const body = dueBody(institutionId);
      const reversed = Object.fromEntries(Object.entries(body).toReversed());
      expect((await raise(body, key)).status).toBe(201);
      const again = await raise(reversed, key);
      expect([again.status, again.headers['idempotent-replayed']]).toEqual([201, 'true']);
      expect(await dueRows(institutionId)).toBe(1);
    });

    it('makes one due, one number and one email from five identical requests at once', async () => {
      const { institutionId, owner } = await world();
      const key = newId();
      const answers = await Promise.all(
        Array.from({ length: 5 }, () => raise(dueBody(institutionId), key)),
      );
      await flush();
      for (const answer of answers) {
        expect([201, 409]).toContain(answer.status);
        if (answer.status === 409) expect(answer.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      }
      expect(await dueRows(institutionId)).toBe(1);
      expect(dueMails(owner.email)).toHaveLength(1);
      expect((await raised(institutionId)).invoiceNo).toBe(`BNX/${TEST_YEAR}/0002`);
    });
  });

  describe('Q5 invoice numbers', () => {
    it('numbers 12 parallel dues across three Societies 1 to 12, with 4 parallel refusals taking none, on a year with no counter yet', async () => {
      const worlds = await Promise.all([world(), world(), world()]);
      const calls = [
        ...Array.from({ length: 12 }, (_, i) => raise(dueBody(worlds[i % 3]!.institutionId))),
        ...Array.from({ length: 4 }, (_, i) =>
          raise(dueBody(worlds[i % 3]!.institutionId, { studentCountNote: null })),
        ),
      ];
      const answers = await Promise.all(calls);
      const made = answers.filter((answer) => answer.status === 201);
      expect(made).toHaveLength(12);
      expect(answers.filter((answer) => answer.status === 422)).toHaveLength(4);
      expect(
        made.map((answer) => numberOf(answer.body.data.invoiceNo)).toSorted((a, b) => a - b),
      ).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(new Set(made.map((answer) => answer.body.data.invoiceNo)).size).toBe(12);
    });

    it('turns the year at exactly 18:30 UTC on 31 March, that is 00:00 on 1 April in India', async () => {
      const { institutionId } = await world();
      await clearYear('FY2034-35');
      t.clock.set('2034-03-31T18:29:59.999Z');
      admin = await signInAdmin();
      expect((await raised(institutionId)).invoiceNo).toBe(`BNX/${TEST_YEAR}/0001`);
      t.clock.set('2034-03-31T18:30:00.000Z');
      admin = await signInAdmin();
      expect((await raised(institutionId)).invoiceNo).toBe('BNX/FY2034-35/0001');
      t.clock.set('2034-03-31T18:29:59.000Z');
      admin = await signInAdmin();
      expect((await raised(institutionId)).invoiceNo).toBe(`BNX/${TEST_YEAR}/0002`);
      await clearYear('FY2034-35');
    });

    it('answers 409 RESOURCE_BUSY, not a hang or 500, while another transaction holds an uncommitted first counter row for the year', async () => {
      const { institutionId } = await world();
      let release!: () => void;
      const hold = new Promise<void>((done) => {
        release = done;
      });
      let started!: () => void;
      const ready = new Promise<void>((done) => {
        started = done;
      });
      const holder = ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`insert into number_sequences (sequence_type, period_key, prefix, next_value)
          values (3, ${TEST_YEAR}, ${`BNX/${TEST_YEAR}/`}, 1)`.execute(tx);
        started();
        await hold;
        throw new Error('roll back');
      });
      await ready;
      const t0 = Date.now();
      const busy = await raise(dueBody(institutionId));
      const waited = Date.now() - t0;
      release();
      await holder.catch(() => undefined);
      expect([busy.status, busy.body.code]).toEqual([409, 'RESOURCE_BUSY']);
      expect(waited).toBeLessThan(10_000);
      expect(await dueRows(institutionId)).toBe(0);
      expect((await raised(institutionId)).invoiceNo).toBe(`BNX/${TEST_YEAR}/0001`);
    }, 30_000);
  });

  describe('Q6 who may call', () => {
    it('leaves no due, number or stored key behind after Owner and Admin 403s, so the next Super Admin due is 0001', async () => {
      const { societyId, institutionId, owner } = await world();
      const adminOf = await fixtures.institutionAdmin(societyId, [institutionId]);
      for (const token of [owner.token, adminOf.token]) {
        const res = await raise(dueBody(institutionId), newId(), token);
        expect(res.status).toBe(403);
      }
      expect(await idempotencyRows()).toBe(0);
      expect((await raised(institutionId)).invoiceNo).toBe(`BNX/${TEST_YEAR}/0001`);
    });

    it('gives an Owner 403 on another Society’s due and quote too', async () => {
      const mine = await world();
      const theirs = await world();
      const due = await raised(theirs.institutionId);
      for (const res of await Promise.all([
        api('get', `${duesPath}/${due.id}`, mine.owner.token),
        api('get', `${duesPath}?societyId=${theirs.societyId}`, mine.owner.token),
        api(
          'get',
          `${quotePath(theirs.institutionId)}?periodStartDate=2026-04-01&periodEndDate=2027-03-31`,
          mine.owner.token,
        ),
      ])) {
        expect(res.status).toBe(403);
      }
    });
  });

  describe('Q7 telling the Owners', () => {
    it('emails each active Owner of the Society once, and nobody in another Society or with a revoked grant', async () => {
      const one = await world();
      const two = await world();
      const second = await extraOwner(one.societyId, 2);
      const gone = await extraOwner(one.societyId, 3);
      await sql`update role_assignments set revoked_at = now() where user_id = ${gone.person}`.execute(
        ownerDb,
      );
      await raised(one.institutionId);
      await flush();
      expect(dueMails(one.owner.email)).toHaveLength(1);
      expect(dueMails(second.email)).toHaveLength(1);
      expect(dueMails(gone.email)).toHaveLength(0);
      expect(dueMails(two.owner.email)).toHaveLength(0);
      expect(t.email.all().filter((mail) => mail.template === 'platform-due-raised')).toHaveLength(
        2,
      );
    });
  });

  describe('Q8 PLT-25 list', () => {
    it('takes LIKE wildcards in q literally and matches the invoice number in any case', async () => {
      const { institutionId } = await world();
      const due = await raised(institutionId);
      const scoped = `institutionId=${institutionId}`;
      expect(await listedIds(`${scoped}&q=%25%25`)).toEqual([]);
      expect(await listedIds(`${scoped}&q=__`)).toEqual([]);
      expect(await listedIds(`${scoped}&q=${encodeURIComponent('bnx/fy2033-34/0001')}`)).toEqual([
        due.id,
      ]);
    });

    it('pages through ties on the sort field without losing or repeating a due', async () => {
      const { institutionId } = await world();
      const made = [];
      for (let i = 0; i < 7; i += 1) made.push((await raised(institutionId)).id);
      for (const sort of [
        'totalAmount',
        '-totalAmount',
        'dueDate',
        'periodStartDate',
        'createdAt',
      ]) {
        const seen: string[] = [];
        for (let page = 1; page <= 4; page += 1) {
          const res = await asAdmin(
            'get',
            `${duesPath}?institutionId=${institutionId}&sort=${sort}&limit=2&page=${page}`,
          );
          expect(res.status).toBe(200);
          seen.push(...(res.body.data as unknown as { id: string }[]).map((row) => row.id));
        }
        expect([sort, seen.toSorted()]).toEqual([sort, made.toSorted()]);
      }
    });

    it('puts dues with no due date in a fixed place when sorting by due date', async () => {
      const { institutionId } = await world();
      const late = await raised(institutionId, { dueDate: '2033-09-01' });
      const none = await raised(institutionId);
      const early = await raised(institutionId, { dueDate: '2033-07-01' });
      const order = async (sort: string) =>
        (
          (await asAdmin('get', `${duesPath}?institutionId=${institutionId}&sort=${sort}`)).body
            .data as unknown as { id: string }[]
        ).map((row) => row.id);
      const up = await order('dueDate');
      const down = await order('-dueDate');
      expect(up.filter((id) => id !== none.id)).toEqual([early.id, late.id]);
      expect(down.filter((id) => id !== none.id)).toEqual([late.id, early.id]);
    });

    it('refuses bad paging and filters with 400, never 500', async () => {
      const bad = [
        'limit=0',
        'limit=101',
        'limit=abc',
        'page=0',
        'page=-1',
        'dueStatus=abc',
        'dueStatus=1.5',
        'institutionId=nope',
        'sort=',
        'sort=--createdAt',
        `q=${'x'.repeat(5000)}`,
        'q=%00',
      ];
      for (const query of bad) {
        const res = await asAdmin('get', `${duesPath}?${query}`);
        expect([query.slice(0, 20), res.status < 500]).toEqual([query.slice(0, 20), true]);
      }
    });

    it('answers a page past the end with no rows and the right totals', async () => {
      const { institutionId } = await world();
      await raised(institutionId);
      const res = await asAdmin('get', `${duesPath}?institutionId=${institutionId}&page=9&limit=5`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toMatchObject({ totalItems: 1, totalPages: 1 });
    });
  });

  describe('Q9 PLT-24 quote', () => {
    it('answers 400 for a missing or backward period and a date that does not exist', async () => {
      const { institutionId } = await world();
      for (const query of [
        '',
        'periodStartDate=2026-04-01',
        'periodStartDate=2026-04-01&periodEndDate=2026-03-31',
        'periodStartDate=2026-02-30&periodEndDate=2026-03-31',
      ]) {
        const res = await asAdmin('get', `${quotePath(institutionId)}?${query}`);
        expect([query, res.status]).toEqual([query, 400]);
      }
    });
  });
});
