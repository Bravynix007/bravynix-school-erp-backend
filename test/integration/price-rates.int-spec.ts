import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
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

type Method = 'get' | 'post' | 'patch' | 'delete';

const ratesPath = (institutionId: string) =>
  `/v1/platform/institutions/${institutionId}/price-rates`;

const rate = (amount: string, effectiveFromDate: string, note?: string) => ({
  ratePerStudentAmount: amount,
  effectiveFromDate,
  ...(note === undefined ? {} : { note }),
});

describe('PLT-22 and PLT-23 per-student rates (PRD 9.2, API design 10.22)', () => {
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

  const setRate = (institutionId: string, body: object) =>
    asAdmin('post', ratesPath(institutionId), body);

  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      society_id: string;
      institution_id: string | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);

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
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    owners.clear();
    await fixtures.cleanup();
  });

  describe('who may call', () => {
    it('keeps pricing from Owners and Admins, who never see what BravyNix charges', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const owner = await ownerOf(societyId);
      const adminOf = await fixtures.institutionAdmin(societyId, [inst.id]);
      await setRate(inst.id, rate('50.00', '2026-04-01'));

      for (const token of [owner.token, adminOf.token]) {
        for (const method of ['get', 'post'] as const) {
          const res = await api(method, ratesPath(inst.id), token, rate('1.00', '2026-04-02'));
          expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
        }
      }
      expect((await request(t.app.getHttpServer()).get(ratesPath(inst.id))).status).toBe(401);
    });

    it('hides the rate rows from an Owner at the database as well', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      await setRate(inst.id, rate('50.00', '2026-04-01'));
      const seen = await database.transaction({ societyId, roleCode: 2 }, (tx) =>
        sql`select id from institution_price_rates`.execute(tx),
      );
      expect(seen.rows).toEqual([]);
    });
  });

  describe('PLT-23 set a rate', () => {
    it('answers 201 with the whole resource, and audits it with the Society and Institution', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const res = await setRate(inst.id, rate('50.00', '2020-01-01', 'Agreed for the year'));
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        id: expect.any(String),
        institutionId: inst.id,
        ratePerStudentAmount: '50.00',
        effectiveFromDate: '2020-01-01',
        note: 'Agreed for the year',
        inForce: true,
        createdAt: expect.stringMatching(/Z$/),
        createdBy: { id: superAdmin.id, displayName: expect.any(String), roleName: 'Super Admin' },
      });
      const [entry, ...rest] = await audit(res.body.data.id);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        action: 'price_rate.set',
        actor_user_id: superAdmin.id,
        society_id: societyId,
        institution_id: inst.id,
        new_values: {
          rate_per_student_amount: '50.00',
          effective_from_date: '2020-01-01',
          note: 'Agreed for the year',
        },
      });
    });

    it('takes a free rate and a note of 500 characters, and leaves the note empty when none is given', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const free = await setRate(inst.id, rate('0.00', '2020-01-01', 'n'.repeat(500)));
      expect(free.status).toBe(201);
      const plain = await setRate(inst.id, rate('99999999.99', '2020-02-01'));
      expect(plain.status).toBe(201);
      expect(plain.body.data).toMatchObject({ ratePerStudentAmount: '99999999.99', note: null });
    });

    it('answers 409 DUPLICATE on effectiveFromDate for a second rate that starts the same day', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      expect((await setRate(inst.id, rate('50.00', '2020-01-01'))).status).toBe(201);
      const again = await setRate(inst.id, rate('60.00', '2020-01-01'));
      expect([again.status, again.body.code]).toEqual([409, 'DUPLICATE']);
      expect(again.body.errors).toContainEqual(
        expect.objectContaining({ field: 'effectiveFromDate', code: 'DUPLICATE' }),
      );
      // The first rate is untouched, and another Institution may start the same day.
      const other = await institution(societyId);
      expect((await setRate(other.id, rate('60.00', '2020-01-01'))).status).toBe(201);
      const history = await asAdmin('get', ratesPath(inst.id));
      expect(history.body.data).toEqual([
        expect.objectContaining({ ratePerStudentAmount: '50.00' }),
      ]);
    });

    it('lets one of two parallel identical requests in and refuses the other', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const answers = await Promise.all([
        setRate(inst.id, rate('50.00', '2020-01-01')),
        setRate(inst.id, rate('50.00', '2020-01-01')),
      ]);
      expect(answers.map((answer) => answer.status).toSorted()).toEqual([201, 409]);
    });

    it.each([
      ['no rate', { effectiveFromDate: '2020-01-01' }, 'ratePerStudentAmount', 'INVALID_TYPE'],
      [
        'a number for the rate',
        { ratePerStudentAmount: 50, effectiveFromDate: '2020-01-01' },
        'ratePerStudentAmount',
        'INVALID_TYPE',
      ],
      [
        'a rate with one decimal',
        rate('50.5', '2020-01-01'),
        'ratePerStudentAmount',
        'INVALID_FORMAT',
      ],
      ['a negative rate', rate('-1.00', '2020-01-01'), 'ratePerStudentAmount', 'INVALID_FORMAT'],
      [
        'a rate past the column',
        rate('100000000.00', '2020-01-01'),
        'ratePerStudentAmount',
        'INVALID_FORMAT',
      ],
      ['no date', { ratePerStudentAmount: '50.00' }, 'effectiveFromDate', 'INVALID_TYPE'],
      [
        'a date that does not exist',
        rate('50.00', '2026-02-30'),
        'effectiveFromDate',
        'INVALID_FORMAT',
      ],
      ['a blank note', rate('50.00', '2020-01-01', ''), 'note', 'TOO_SHORT'],
      [
        'a note of 501 characters',
        rate('50.00', '2020-01-01', 'n'.repeat(501)),
        'note',
        'TOO_LONG',
      ],
      [
        'a field it does not know',
        { ...rate('50.00', '2020-01-01'), institutionId: 'x' },
        'institutionId',
        'FIELD_NOT_ALLOWED',
      ],
    ])('answers 400 for %s', async (_what, body, field, code) => {
      const societyId = await society();
      const inst = await institution(societyId);
      const res = await setRate(inst.id, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors).toContainEqual(expect.objectContaining({ field, code }));
    });

    it('answers 404 for an unknown Institution, and for an ID that is not a UUID', async () => {
      expect((await setRate(missing, rate('50.00', '2020-01-01'))).status).toBe(404);
      expect((await setRate('nope', rate('50.00', '2020-01-01'))).status).toBe(404);
    });

    it('answers 409 INVALID_STATE for a deactivated Institution or Society, and writes nothing', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const owner = await ownerOf(societyId);
      await api('delete', `/v1/institutions/${inst.id}`, owner.token);
      const closed = await setRate(inst.id, rate('50.00', '2020-01-01'));
      expect([closed.status, closed.body.code]).toEqual([409, 'INVALID_STATE']);

      const otherSociety = await society();
      const open = await institution(otherSociety);
      await asAdmin('delete', `/v1/platform/societies/${otherSociety}`);
      const inactive = await setRate(open.id, rate('50.00', '2020-01-01'));
      expect([inactive.status, inactive.body.code]).toEqual([409, 'INVALID_STATE']);

      // The history stays readable, and empty.
      expect((await asAdmin('get', ratesPath(inst.id))).body.data).toEqual([]);
    });
  });

  describe('PLT-22 rate history', () => {
    it('is empty for an Institution with no rate yet', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const res = await asAdmin('get', ratesPath(inst.id));
      expect([res.status, res.body.data, res.body.meta]).toEqual([200, [], null]);
    });

    it('lists the latest start first and marks the one rate in force today, never a future one', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      // Added out of order on purpose: the order comes from the dates.
      await setRate(inst.id, rate('55.00', '2021-06-01'));
      await setRate(inst.id, rate('50.00', '2020-01-01'));
      await setRate(inst.id, rate('70.00', '2999-01-01', 'Next century'));

      const res = await asAdmin('get', ratesPath(inst.id));
      expect(res.status).toBe(200);
      expect(
        (res.body.data as unknown as { effectiveFromDate: string; inForce: boolean }[]).map(
          (row) => [row.effectiveFromDate, row.inForce],
        ),
      ).toEqual([
        ['2999-01-01', false],
        ['2021-06-01', true],
        ['2020-01-01', false],
      ]);
    });

    it('marks nothing when every rate starts later', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const created = await setRate(inst.id, rate('70.00', '2999-01-01'));
      expect(created.body.data).toMatchObject({ inForce: false });
      const res = await asAdmin('get', ratesPath(inst.id));
      expect((res.body.data as unknown as { inForce: boolean }[]).some((row) => row.inForce)).toBe(
        false,
      );
    });

    it('shows only the rates of that Institution, and answers 404 for an unknown one', async () => {
      const societyId = await society();
      const first = await institution(societyId);
      const second = await institution(societyId);
      await setRate(first.id, rate('50.00', '2020-01-01'));
      await setRate(second.id, rate('65.00', '2020-01-01'));
      const res = await asAdmin('get', ratesPath(first.id));
      expect(res.body.data).toEqual([expect.objectContaining({ ratePerStudentAmount: '50.00' })]);
      expect((await asAdmin('get', ratesPath(missing))).status).toBe(404);
    });
  });

  describe('the table', () => {
    it('keeps every rate: the app role can neither change nor delete one', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const created = await setRate(inst.id, rate('50.00', '2020-01-01'));
      const id = created.body.data.id;
      const tenant = { personId: superAdmin.id, roleCode: 1 as const };
      await expect(
        database.transaction(tenant, (tx) =>
          sql`update institution_price_rates set rate_per_student_amount = '1.00' where id = ${id}`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.transaction(tenant, (tx) =>
          sql`delete from institution_price_rates where id = ${id}`.execute(tx),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('refuses a negative rate and a blank note even when written directly', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const tenant = { personId: superAdmin.id, roleCode: 1 as const, societyId };
      const insert = (amount: string, note: string | null) =>
        database.transaction(tenant, (tx) =>
          sql`insert into institution_price_rates
              (society_id, institution_id, rate_per_student_amount, effective_from_date, note, created_by)
            values (${societyId}, ${inst.id}, ${amount}, '2020-01-01', ${note}, ${superAdmin.id})`.execute(
            tx,
          ),
        );
      await expect(insert('-0.01', null)).rejects.toThrow(/ck_institution_price_rates_rate/);
      await expect(insert('1.00', '   ')).rejects.toThrow(/ck_institution_price_rates_note/);
    });

    it('refuses a rate whose Society is not the Institution’s own', async () => {
      const societyId = await society();
      const other = await society();
      const inst = await institution(societyId);
      const tenant = { personId: superAdmin.id, roleCode: 1 as const };
      await expect(
        database.transaction(tenant, (tx) =>
          sql`insert into institution_price_rates
              (society_id, institution_id, rate_per_student_amount, effective_from_date, created_by)
            values (${other}, ${inst.id}, '1.00', '2020-01-01', ${superAdmin.id})`.execute(tx),
        ),
      ).rejects.toThrow(/fk_institution_price_rates_institution/);
    });
  });
});
