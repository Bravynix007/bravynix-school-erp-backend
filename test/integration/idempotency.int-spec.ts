import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { IdempotencyService } from '../../src/platform/idempotency/index.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { superAdminToken } from '../support/admin-token.js';
import { FixtureModule, idempotentFixture } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const first = personaByKey('SA1');
const second = personaByKey('SA2');

/** The number part of `BNX/FY2026-27/0007`, as a number. */
const numberOf = (invoiceNo: string) => Number(invoiceNo.split('/').at(-1));

describe('Idempotency-Key and gap-free invoice numbers (API design 14, DDD 9.1)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let tokens: { first: string; second: string };

  const call = (mode: string, key: string | undefined, body: object = {}, token = tokens.first) => {
    let req = request(t.app.getHttpServer())
      .post(`/v1/fixtures/idempotent/${mode}`)
      .set('Authorization', `Bearer ${token}`);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body);
  };

  /** The sequence rows are shared by every test file, so each test starts from none. */
  const clearState = () =>
    ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      await sql`delete from number_sequences where sequence_type = 3`.execute(tx);
      await sql`delete from idempotency_keys`.execute(tx);
    });

  const counter = async () => {
    const rows = await ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      return sql<{ period_key: string; next_value: number }>`
        select period_key, next_value from number_sequences where sequence_type = 3
        order by period_key`.execute(tx);
    });
    return rows.rows;
  };

  /** Moves the fixture clock and signs in again, because a token is only good for 15 minutes of the clock. */
  const moveClock = async (instant: Date | string) => {
    t.clock.set(instant);
    await ownerDb.transaction().execute(async (tx) => {
      await sql`update auth_sessions set idle_expires_at = '2030-01-01', absolute_expires_at = '2030-01-01'`.execute(
        tx,
      );
    });
    tokens = {
      first: await superAdminToken(t, ownerDb, first.id),
      second: await superAdminToken(t, ownerDb, second.id),
    };
    await ownerDb.transaction().execute(async (tx) => {
      await sql`update auth_sessions set idle_expires_at = '2030-01-01', absolute_expires_at = '2030-01-01'`.execute(
        tx,
      );
    });
  };

  /** Makes every stored answer 25 hours old. There is no update policy, so the owner steps around row-level security for this one write. */
  const ageStoredAnswers = () =>
    ownerDb.transaction().execute(async (tx) => {
      await sql`alter table idempotency_keys no force row level security`.execute(tx);
      await sql`update idempotency_keys set created_at = now() - interval '25 hours',
        expires_at = now() - interval '1 hour'`.execute(tx);
      await sql`alter table idempotency_keys force row level security`.execute(tx);
    });

  /** How many answers are stored. Row-level security applies to the table owner too, so count per person. */
  const stored = async () => {
    let total = 0;
    for (const person of [first.id, second.id]) {
      total += await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.person_id', ${person}, true)`.execute(tx);
        return (
          await sql<{ n: number }>`select count(*)::int as n from idempotency_keys`.execute(tx)
        ).rows[0]!.n;
      });
    }
    return total;
  };

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
    await clearState();
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    await clearState();
    idempotentFixture.reset();
    t.clock.set('2026-06-01T04:30:00.000Z');
    tokens = {
      first: await superAdminToken(t, ownerDb, first.id),
      second: await superAdminToken(t, ownerDb, second.id),
    };
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
  });

  describe('the key', () => {
    it('is required: 400 IDEMPOTENCY_KEY_REQUIRED, and nothing runs', async () => {
      const res = await call('plain', undefined);
      expect([res.status, res.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      expect(idempotentFixture.runs).toBe(0);
    });

    it('must be a UUID: 400 on the header, and nothing runs', async () => {
      const res = await call('plain', 'not-a-uuid');
      expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(res.body.errors).toContainEqual(
        expect.objectContaining({ field: 'Idempotency-Key', code: 'INVALID_FORMAT' }),
      );
      expect(idempotentFixture.runs).toBe(0);
    });
  });

  describe('a repeat', () => {
    it('gets the first answer back unchanged, flagged as replayed, and runs nothing again', async () => {
      const key = newId();
      const one = await call('plain', key, { label: 'a' });
      expect([one.status, one.body.code]).toEqual([201, 'CREATED']);
      expect(one.headers['idempotent-replayed']).toBeUndefined();
      expect(one.body.data).toEqual({ invoiceNo: 'BNX/FY2026-27/0001' });

      const again = await call('plain', key, { label: 'a' });
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.data).toEqual(one.body.data);
      expect(again.body.code).toBe(one.body.code);
      expect(idempotentFixture.runs).toBe(1);
      // The repeat took no number: the next new request gets the next one.
      const next = await call('plain', newId());
      expect(next.body.data).toEqual({ invoiceNo: 'BNX/FY2026-27/0002' });
    });

    it('does not care in what order the body’s fields come', async () => {
      const key = newId();
      await call('plain', key, { label: 'a' });
      const again = await call('plain', key, { label: 'a' });
      expect(again.headers['idempotent-replayed']).toBe('true');
    });

    it('answers 422 IDEMPOTENCY_KEY_REUSED for the same key with another request, and takes no number', async () => {
      const key = newId();
      await call('plain', key, { label: 'a' });
      for (const [mode, body] of [
        ['plain', { label: 'b' }],
        ['other', { label: 'a' }],
      ] as const) {
        const res = await call(mode, key, body);
        expect([res.status, res.body.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
      }
      expect(idempotentFixture.runs).toBe(1);
      expect((await counter())[0]!.next_value).toBe(2);
    });

    it('keeps each person’s keys apart: the same key from another Super Admin is a new request', async () => {
      const key = newId();
      const mine = await call('plain', key);
      const theirs = await call('plain', key, {}, tokens.second);
      expect(theirs.status).toBe(201);
      expect(theirs.headers['idempotent-replayed']).toBeUndefined();
      expect(theirs.body.data).toEqual({ invoiceNo: 'BNX/FY2026-27/0002' });
      expect(mine.body.data).toEqual({ invoiceNo: 'BNX/FY2026-27/0001' });
      expect(await stored()).toBe(2);
    });

    it('answers 409 IDEMPOTENCY_IN_PROGRESS with Retry-After 1 while the first is still running, then replays it', async () => {
      const key = newId();
      const slow = call('slow', key).then((res) => res);
      await vi.waitFor(() => expect(idempotentFixture.runs).toBe(1));
      const busy = await call('slow', key);
      expect([busy.status, busy.body.code]).toEqual([409, 'IDEMPOTENCY_IN_PROGRESS']);
      expect(busy.headers['retry-after']).toBe('1');

      idempotentFixture.release?.();
      const done = await slow;
      expect(done.status).toBe(201);
      const replay = await call('slow', key);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.data).toEqual(done.body.data);
      expect(idempotentFixture.runs).toBe(1);
    });

    it('lets one of two parallel identical requests run, and the other either waits for it or replays it', async () => {
      const key = newId();
      const answers = await Promise.all([call('plain', key), call('plain', key)]);
      const statuses = answers.map((res) => res.status).toSorted();
      // Either the second saw the first still running (409) or already done (201 replay).
      expect(statuses[0] === 201 && (statuses[1] === 201 || statuses[1] === 409)).toBe(true);
      expect(idempotentFixture.runs).toBe(1);
      expect((await counter())[0]!.next_value).toBe(2);
    });
  });

  describe('what is stored', () => {
    it('keeps a 422 refusal and sends the same refusal again, without running or numbering again', async () => {
      const key = newId();
      const one = await call('refuse', key);
      expect([one.status, one.body.code]).toEqual([422, 'BUSINESS_RULE']);
      const again = await call('refuse', key);
      expect([again.status, again.body.code]).toEqual([422, 'BUSINESS_RULE']);
      expect(again.body.message).toBe(one.body.message);
      expect(idempotentFixture.runs).toBe(1);
      // The number the refused work took was handed back.
      expect(await counter()).toEqual([]);
    });

    it('keeps a 409 refusal too', async () => {
      const key = newId();
      expect((await call('conflict', key)).status).toBe(409);
      const again = await call('conflict', key);
      expect([again.status, again.body.code]).toEqual([409, 'DUPLICATE']);
      expect(idempotentFixture.runs).toBe(1);
    });

    it('keeps nothing of a 400 or a server error, so the same key works once the cause is fixed', async () => {
      const bad = newId();
      expect((await call('invalid', bad)).status).toBe(400);
      expect((await call('invalid', bad)).status).toBe(400);
      expect(idempotentFixture.runs).toBe(2);

      const flaky = newId();
      expect((await call('flaky', flaky)).status).toBe(500);
      expect(await stored()).toBe(0);
      const retried = await call('flaky', flaky);
      expect([retried.status, retried.headers['idempotent-replayed']]).toEqual([201, undefined]);
    });

    it('forgets an answer after 24 hours: the same key then runs again, and the sweep removes the old rows', async () => {
      const key = newId();
      await call('plain', key);
      await ageStoredAnswers();
      // The fixture clock is fixed in 2026, so move it past the stored expiry.
      await moveClock(new Date(Date.now() + 60_000));
      const again = await call('plain', key);
      expect([again.status, again.headers['idempotent-replayed']]).toEqual([201, undefined]);
      expect(idempotentFixture.runs).toBe(2);

      await ageStoredAnswers();
      const removed = await t.app.get(IdempotencyService).sweepExpired();
      expect(removed).toBe(1);
      expect(await stored()).toBe(0);
    });
  });

  describe('invoice numbers', () => {
    it('are gap-free: a number taken by work that failed is handed back, so the retry gets it', async () => {
      const a = await call('plain', newId());
      expect(numberOf(a.body.data.invoiceNo as string)).toBe(1);
      const key = newId();
      expect((await call('flaky', key)).status).toBe(500);
      expect((await call('refuse', newId())).status).toBe(422);
      const retried = await call('flaky', key);
      expect(numberOf(retried.body.data.invoiceNo as string)).toBe(2);
      const c = await call('plain', newId());
      expect(numberOf(c.body.data.invoiceNo as string)).toBe(3);
      expect((await counter())[0]!.next_value).toBe(4);
    });

    it('are unique and in sequence when eight requests race', async () => {
      const answers = await Promise.all(Array.from({ length: 8 }, () => call('plain', newId())));
      expect(answers.map((res) => res.status)).toEqual(Array(8).fill(201));
      const numbers = answers.map((res) => numberOf(res.body.data.invoiceNo as string));
      expect(numbers.toSorted((x, y) => x - y)).toEqual(Array.from({ length: 8 }, (_, i) => i + 1));
    });

    it('restart at 0001 each 1 April, and the earlier year keeps its own count', async () => {
      await call('plain', newId());
      await call('plain', newId());
      await moveClock('2027-03-31T10:00:00.000Z');
      expect((await call('plain', newId())).body.data).toEqual({ invoiceNo: 'BNX/FY2026-27/0003' });
      // 1 April 00:00 in India is 31 March 18:30 UTC.
      await moveClock('2027-03-31T18:30:00.000Z');
      expect((await call('plain', newId())).body.data).toEqual({ invoiceNo: 'BNX/FY2027-28/0001' });
      expect((await call('plain', newId())).body.data).toEqual({ invoiceNo: 'BNX/FY2027-28/0002' });
      expect(await counter()).toEqual([
        { period_key: 'FY2026-27', next_value: 4 },
        { period_key: 'FY2027-28', next_value: 3 },
      ]);
    });
  });

  describe('the tables', () => {
    const tenant = { personId: first.id, roleCode: 1 as const };

    const insert = (type: number, society: string | null) =>
      database.transaction(tenant, (tx) =>
        sql`insert into number_sequences (sequence_type, society_id, period_key, prefix)
          values (${type}, ${society}, 'K', 'P/')`.execute(tx),
      );

    it('never let the app role edit a stored answer or delete or rewrite a counter', async () => {
      await call('plain', newId());
      for (const statement of [
        sql`update idempotency_keys set response_status = 200`,
        sql`truncate idempotency_keys`,
        sql`delete from number_sequences`,
        sql`update number_sequences set prefix = 'X/'`,
        sql`update number_sequences set period_key = 'FY1999-00'`,
      ]) {
        await expect(database.transaction(tenant, (tx) => statement.execute(tx))).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it('keeps a stored answer to the person who made it: an Owner cannot read, write as them or delete it', async () => {
      await call('plain', newId());
      const owner = { personId: newId(), societyId: newId(), roleCode: 2 as const };
      for (const tenantOf of [owner, {}]) {
        const seen = await database.transaction(tenantOf, (tx) =>
          sql`select user_id from idempotency_keys`.execute(tx),
        );
        expect(seen.rows).toEqual([]);
      }
      const mine = await database.transaction(tenant, (tx) =>
        sql`select user_id from idempotency_keys`.execute(tx),
      );
      expect(mine.rows).toHaveLength(1);
      // Writing a row in another person's name is refused, whoever asks.
      await expect(
        database.transaction({ ...tenant, personId: second.id }, (tx) =>
          sql`insert into idempotency_keys
              (user_id, idempotency_key, operation, request_fingerprint, response_status, response_body, expires_at)
            values (${first.id}, ${newId()}, 'x', '\\x00', 201, '{}', now() + interval '1 hour')`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      const ownerDelete = await database.transaction(owner, (tx) =>
        sql`delete from idempotency_keys`.execute(tx),
      );
      expect(ownerDelete.numAffectedRows).toBe(0n);
      expect(await stored()).toBe(1);
    });

    it('keep a platform invoice counter to Super Admin: an Owner reads and writes none', async () => {
      await call('plain', newId());
      const society = newId();
      const seen = await database.transaction({ societyId: society, roleCode: 2 }, (tx) =>
        sql`select id from number_sequences`.execute(tx),
      );
      expect(seen.rows).toEqual([]);
      await expect(
        database.transaction({ societyId: society, roleCode: 2 }, (tx) =>
          sql`insert into number_sequences (sequence_type, period_key, prefix) values (3, 'FY2099-00', 'X/')`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('refuse a platform invoice counter that names a Society, and a receipt counter that names none', async () => {
      await expect(insert(3, newId())).rejects.toThrow(/ck_number_sequences_scope|foreign key/);
      await expect(insert(1, null)).rejects.toThrow(/ck_number_sequences_scope/);
      await expect(insert(9, null)).rejects.toThrow(/ck_number_sequences_(scope|type)/);
    });

    it('refuse a counter that starts below 1 and a second counter for the same year', async () => {
      await call('plain', newId());
      await expect(
        database.transaction(tenant, (tx) =>
          sql`insert into number_sequences (sequence_type, period_key, prefix, next_value)
            values (3, 'FY2026-27', 'BNX/FY2026-27/', 1)`.execute(tx),
        ),
      ).rejects.toThrow(/uq_number_sequences_scope/);
      await expect(
        database.transaction(tenant, (tx) =>
          sql`insert into number_sequences (sequence_type, period_key, prefix, next_value)
            values (3, 'FY2030-31', 'BNX/FY2030-31/', 0)`.execute(tx),
        ),
      ).rejects.toThrow(/ck_number_sequences_next/);
    });
  });
});
