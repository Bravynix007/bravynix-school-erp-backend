import { Kysely, PostgresDialect, sql } from 'kysely';
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

describe('QA: PLT-22 and PLT-23 per-student rates', () => {
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
  // The test app runs on a fixed clock: days are counted from its IST day.
  const istDay = (offsetDays: number) =>
    new Date(Date.parse(`${t.clock.todayIst()}T00:00:00Z`) + offsetDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

  it('R1 money: only plain two-decimal strings up to eight whole digits', async () => {
    const societyId = await society();
    const inst = await institution(societyId);
    const spaced = await setRate(inst.id, rate(' 50.00 ', '2001-02-01'));
    console.log('R1 spaced:', spaced.status, spaced.body.data?.ratePerStudentAmount);
    const refused = [
      '50',
      '50.0',
      '50.000',
      '+5.00',
      '-0.00',
      '1e2',
      '5,0.00',
      '١٢.٠٠',
      '５０.００',
      '123456789.00',
      '.50',
      '50.',
    ];
    const answers: string[] = [];
    let day = 1;
    for (const amount of refused) {
      const res = await setRate(inst.id, rate(amount, `2001-01-${String(day++).padStart(2, '0')}`));
      answers.push(`${JSON.stringify(amount)}=${res.status}`);
    }
    console.log('R1 refused:', answers.join(' '));
    expect(answers.filter((a) => !a.endsWith('=400'))).toEqual([]);
    const max = await setRate(inst.id, rate('99999999.99', '2002-01-01'));
    const zero = await setRate(inst.id, rate('0.00', '2002-01-02'));
    const padded = await setRate(inst.id, rate('00000007.50', '2002-01-03'));
    console.log(
      'R1 accepted:',
      max.status,
      max.body.data?.ratePerStudentAmount,
      zero.status,
      padded.status,
      padded.body.data?.ratePerStudentAmount,
    );
    expect([max.status, zero.status, padded.status]).toEqual([201, 201, 201]);
    expect(max.body.data.ratePerStudentAmount).toBe('99999999.99');
    expect(padded.body.data.ratePerStudentAmount).toBe('7.50');
  });

  it('R2 dates: real calendar days only, and never a 500', async () => {
    const societyId = await society();
    const inst = await institution(societyId);
    const cases = [
      '2027-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-4-1',
      '2026-04-01T00:00:00Z',
      '20260401',
      '0000-01-01',
      '0001-01-01',
      '9999-12-31',
      '2028-02-29',
      '1900-01-01',
    ];
    const answers: string[] = [];
    for (const day of cases) {
      const res = await setRate(inst.id, rate('1.00', day));
      answers.push(`${day}=${res.status}${res.status >= 400 ? `/${res.body.code}` : ''}`);
    }
    console.log('R2:', answers.join(' '));
    expect(answers.filter((a) => /=5\d\d/.test(a))).toEqual([]);
    expect(answers).toEqual(
      expect.arrayContaining([
        '2027-02-29=400/VALIDATION_FAILED',
        '2026-04-31=400/VALIDATION_FAILED',
        '2028-02-29=201',
        '9999-12-31=201',
      ]),
    );
  });

  it('R3 a note of spaces only or whitespace is a 400, and emoji are fine', async () => {
    const societyId = await society();
    const inst = await institution(societyId);
    const spaces = await setRate(inst.id, rate('1.00', '2003-01-01', '   '));
    const tabs = await setRate(inst.id, rate('1.00', '2003-01-03', '\t\n'));
    const emoji = await setRate(inst.id, rate('1.00', '2003-01-04', '😀'.repeat(250)));
    console.log(
      'R3:',
      spaces.status,
      spaces.body.code,
      '| tabs',
      tabs.status,
      tabs.body.code,
      '| 250 emoji',
      emoji.status,
    );
    expect.soft(spaces.status, 'spaces-only note').toBe(400);
    expect.soft(tabs.status, 'whitespace-only note').toBe(400);
    expect.soft(emoji.status).toBe(201);
  });

  it('R4 five parallel rates for one day: one 201, four 409 DUPLICATE, one row and one audit entry', async () => {
    const societyId = await society();
    const inst = await institution(societyId);
    const answers = await Promise.all(
      ['1.00', '2.00', '3.00', '4.00', '5.00'].map((a) => setRate(inst.id, rate(a, '2004-01-01'))),
    );
    console.log('R4:', answers.map((a) => `${a.status}/${a.body.code}`).join(' '));
    expect(answers.map((a) => a.status).toSorted()).toEqual([201, 409, 409, 409, 409]);
    expect(answers.filter((a) => a.status === 409).every((a) => a.body.code === 'DUPLICATE')).toBe(
      true,
    );
    const asPlatform = {
      personId: superAdmin.id,
      roleCode: 1,
      societyId,
      institutionIds: [inst.id],
    };
    const rows = await database.transaction(asPlatform, (tx) =>
      sql<{
        n: number;
      }>`select count(*)::int as n from institution_price_rates where institution_id = ${inst.id}`.execute(
        tx,
      ),
    );
    const audits = (await audit(answers.find((a) => a.status === 201)!.body.data.id)).length;
    expect([rows.rows[0]!.n, audits]).toEqual([1, 1]);
  });

  it('R5 in force is decided by the IST day: yesterday, today and tomorrow', async () => {
    const societyId = await society();
    const inst = await institution(societyId);
    for (const [amount, day] of [
      ['1.00', istDay(-1)],
      ['2.00', istDay(0)],
      ['3.00', istDay(1)],
    ] as const) {
      expect((await setRate(inst.id, rate(amount, day))).status).toBe(201);
    }
    const res = await asAdmin('get', ratesPath(inst.id));
    const rows = res.body.data as unknown as {
      ratePerStudentAmount: string;
      effectiveFromDate: string;
      inForce: boolean;
    }[];
    console.log(
      'R5:',
      rows.map((r) => `${r.effectiveFromDate}:${r.ratePerStudentAmount}:${r.inForce}`).join(' '),
    );
    expect(rows.map((r) => r.ratePerStudentAmount)).toEqual(['3.00', '2.00', '1.00']);
    expect(rows.map((r) => r.inForce)).toEqual([false, true, false]);
    // A past rate added after the current one does not take over.
    const late = await setRate(inst.id, rate('9.00', istDay(-30)));
    expect(late.body.data.inForce).toBe(false);
  });

  it('R7 another Society’s Owner, a teacher-less tenant and a malformed path learn nothing', async () => {
    const societyId = await society();
    const inst = await institution(societyId);
    await setRate(inst.id, rate('5.00', '2006-01-01'));
    const other = await society();
    const otherOwner = await ownerOf(other);
    const res = await api('get', ratesPath(inst.id), otherOwner.token);
    const bad = await asAdmin('get', '/v1/platform/institutions/not-a-uuid/price-rates');
    const upper = await asAdmin('get', ratesPath(inst.id.toUpperCase()));
    const notFound = await asAdmin('get', ratesPath(missing));
    console.log(
      'R7:',
      res.status,
      res.body.code,
      '| bad id',
      bad.status,
      '| upper-case id',
      upper.status,
      '| unknown',
      notFound.status,
      notFound.body.code,
    );
    expect(res.status).toBe(403);
    expect(bad.status).toBe(404);
    expect(notFound.status).toBe(404);
    const anon = await database.transaction({}, (tx) =>
      sql`select id from institution_price_rates`.execute(tx),
    );
    expect(anon.rows).toEqual([]);
  });

  it('R8 no route edits or deletes a rate', async () => {
    const societyId = await society();
    const inst = await institution(societyId);
    const created = await setRate(inst.id, rate('5.00', '2007-01-01'));
    const id = created.body.data.id;
    const answers = [];
    for (const [method, path] of [
      ['patch', `${ratesPath(inst.id)}/${id}`],
      ['delete', `${ratesPath(inst.id)}/${id}`],
      ['patch', ratesPath(inst.id)],
      ['delete', ratesPath(inst.id)],
    ] as const) {
      answers.push((await asAdmin(method, path, { ratePerStudentAmount: '1.00' })).status);
    }
    console.log('R8:', answers.join(' '));
    expect(answers.every((s) => s === 404 || s === 405)).toBe(true);
  });
});
