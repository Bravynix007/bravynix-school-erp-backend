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

interface Year {
  id: string;
  institutionId: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  status: number;
  version: number;
}

const YEARS = '/v1/academic-years';

describe('AY-01 to AY-05 academic years (PRD 7.2, API design 10.4h)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];

  /** Society A with two Institutions (the Admin has only the first) and Society B with one. */
  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let societyA: string;
  let first: string;
  let second: string;
  let other: string;
  let societyB: string;

  const makeSociety = async () => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    societies.push(res.body.data.id);
    return res.body.data.id;
  };

  const makeInstitution = async (token: string) => {
    const res = await api('post', '/v1/institutions', token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
    });
    expect(res.status).toBe(201);
    return res.body.data.id;
  };

  const add = (token: string, institutionId: string, fields: object = {}) =>
    api('post', YEARS, token, {
      institutionId,
      name: '2026-2027',
      startDate: '2026-06-01',
      endDate: '2027-03-31',
      ...fields,
    });

  const added = async (institutionId: string, fields: object = {}, token = owner.token) => {
    const res = await add(token, institutionId, fields);
    expect(res.status).toBe(201);
    return res.body.data as unknown as Year;
  };

  const years = async (institutionId: string, token = owner.token) => {
    const res = await api('get', `${YEARS}?institutionId=${institutionId}`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Year[];
  };

  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      society_id: string;
      institution_id: string;
      entity_type: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);

  const call = (method: Method, path: string, body: object = {}, token = owner.token) =>
    api(method, path, token, body);

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
    societyA = await makeSociety();
    owner = await fixtures.owner(societyA);
    first = await makeInstitution(owner.token);
    second = await makeInstitution(owner.token);
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
    societyB = await makeSociety();
    otherOwner = await fixtures.owner(societyB);
    other = await makeInstitution(otherOwner.token);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    await fixtures.cleanup();
  });

  describe('AY-02 add a year', () => {
    it('makes the first year current, and later ones not, with the audit entry', async () => {
      const one = await added(first);
      expect(one).toMatchObject({
        institutionId: first,
        name: '2026-2027',
        startDate: '2026-06-01',
        endDate: '2027-03-31',
        isCurrent: true,
        status: 1,
        version: 1,
      });
      const two = await added(first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      expect(two.isCurrent).toBe(false);

      const [row, ...rest] = await audit(one.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        action: 'academic_year.created',
        entity_type: 'academic_year',
        actor_user_id: owner.person,
        society_id: societyA,
        institution_id: first,
        old_values: null,
      });
      expect(row!.new_values).toMatchObject({ name: '2026-2027', is_current: true });
    });

    it('is open to the Institution Admin of that Institution, and to no one else in the Society', async () => {
      const year = await added(first, {}, institutionAdmin.token);
      expect(year.institutionId).toBe(first);
      const refused = await add(institutionAdmin.token, second);
      expect(refused.status).toBe(404);
      expect(await years(second)).toEqual([]);
    });

    it('cannot add to another Society’s Institution, nor to an unknown one', async () => {
      for (const institutionId of [other, missing]) {
        const res = await add(owner.token, institutionId);
        expect(res.status).toBe(404);
      }
      expect(await years(other, otherOwner.token)).toEqual([]);
    });

    it('is not for Super Admin', async () => {
      const res = await add(admin, first);
      expect(res.status).toBe(403);
    });

    it('refuses an overlap with another active year, an adjacent one is fine', async () => {
      await added(first);
      const overlap = await add(owner.token, first, {
        name: '2026-27 B',
        startDate: '2027-03-31',
        endDate: '2027-12-31',
      });
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('YEAR_OVERLAP');

      const inside = await add(owner.token, first, {
        name: 'Inside',
        startDate: '2026-07-01',
        endDate: '2026-08-01',
      });
      expect(inside.body.code).toBe('YEAR_OVERLAP');

      const adjacent = await add(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-04-01',
        endDate: '2028-03-31',
      });
      expect(adjacent.status).toBe(201);
      expect(await years(first)).toHaveLength(2);
    });

    it('lets two Institutions have the same dates and name', async () => {
      await added(first);
      await added(second);
      await added(other, {}, otherOwner.token);
      expect(await years(second)).toHaveLength(1);
    });

    it('refuses a name used by an active year, whatever the letter case', async () => {
      await added(first, { name: 'AY 2026-27' });
      const res = await add(owner.token, first, {
        name: 'ay 2026-27',
        startDate: '2030-06-01',
        endDate: '2031-03-31',
      });
      expect(res.status).toBe(409);
      expect(res.body.errors?.[0]).toMatchObject({ field: 'name', code: 'DUPLICATE' });
    });

    it('refuses an end that is not after the start, and bad fields, writing nothing', async () => {
      const same = await add(owner.token, first, {
        startDate: '2026-06-01',
        endDate: '2026-06-01',
      });
      expect(same.status).toBe(400);
      expect(same.body.errors?.[0]).toMatchObject({ field: 'endDate', code: 'OUT_OF_RANGE' });
      const before = await add(owner.token, first, { endDate: '2026-05-01' });
      expect(before.status).toBe(400);

      const bad = await call('post', YEARS, {
        institutionId: first,
        name: 'x'.repeat(21),
        startDate: '2026-02-30',
        endDate: '2027-03-31',
        isCurrent: true,
      });
      expect(bad.status).toBe(400);
      const fields = Object.fromEntries((bad.body.errors ?? []).map((e) => [e.field, e.code]));
      expect(fields).toMatchObject({
        name: 'TOO_LONG',
        startDate: 'INVALID_FORMAT',
        isCurrent: 'FIELD_NOT_ALLOWED',
      });
      expect(await years(first)).toEqual([]);
    });

    it('gives the first year to only one of two requests made together', async () => {
      const [a, b] = await Promise.all([
        add(owner.token, first, { name: 'A', startDate: '2026-06-01', endDate: '2027-03-31' }),
        add(owner.token, first, { name: 'B', startDate: '2027-06-01', endDate: '2028-03-31' }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      const all = await years(first);
      expect(all.filter((year) => year.isCurrent)).toHaveLength(1);
    });
  });

  describe('AY-01 list the years', () => {
    it('lists the active years, the latest start first, for the Owner and the Admin', async () => {
      const early = await added(first, {
        name: '2025-2026',
        startDate: '2025-06-01',
        endDate: '2026-03-31',
      });
      const late = await added(first);
      for (const token of [owner.token, institutionAdmin.token]) {
        expect((await years(first, token)).map((year) => year.id)).toEqual([late.id, early.id]);
      }
    });

    it('reads an Institution ID sent in upper case, in the query and in the body', async () => {
      const year = await added(first.toUpperCase());
      expect(year.institutionId).toBe(first);
      expect((await years(first.toUpperCase())).map((item) => item.id)).toEqual([year.id]);
    });

    it('needs the Institution, and shows nothing of another Society or an Institution out of scope', async () => {
      await added(other, {}, otherOwner.token);
      await added(second);
      const noInstitution = await call('get', YEARS);
      expect(noInstitution.status).toBe(400);
      expect(noInstitution.body.errors?.[0]).toMatchObject({ field: 'institutionId' });
      expect((await call('get', `${YEARS}?institutionId=${other}`)).status).toBe(404);
      expect(
        (await call('get', `${YEARS}?institutionId=${second}`, {}, institutionAdmin.token)).status,
      ).toBe(404);
      expect((await call('get', `${YEARS}?institutionId=${first}`, {}, admin)).status).toBe(403);
    });
  });

  describe('AY-03 edit a year', () => {
    it('changes the name and dates with the version, and audits before and after', async () => {
      const year = await added(first);
      const res = await call('patch', `${YEARS}/${year.id}`, {
        version: 1,
        name: 'Year 26',
        endDate: '2027-04-15',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        name: 'Year 26',
        endDate: '2027-04-15',
        startDate: '2026-06-01',
        version: 2,
        isCurrent: true,
      });
      const rows = await audit(year.id);
      expect(rows.at(-1)).toMatchObject({
        action: 'academic_year.updated',
        old_values: { name: '2026-2027', end_date: '2027-03-31' },
        new_values: { name: 'Year 26', end_date: '2027-04-15' },
      });
    });

    it('answers a stale version with 409, and a request that changes nothing writes nothing', async () => {
      const year = await added(first);
      await call('patch', `${YEARS}/${year.id}`, { version: 1, name: 'Changed' });
      const stale = await call('patch', `${YEARS}/${year.id}`, { version: 1, name: 'Again' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect(stale.body.data).toMatchObject({ currentVersion: 2 });

      const same = await call('patch', `${YEARS}/${year.id}`, { version: 2, name: 'Changed' });
      expect(same.status).toBe(200);
      expect(same.body.data.version).toBe(2);
      expect(await audit(year.id)).toHaveLength(2);
    });

    it('keeps the rules: no overlap, the end after the start, a free name, and isCurrent is not a field', async () => {
      const one = await added(first);
      const two = await added(first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      const overlap = await call('patch', `${YEARS}/${two.id}`, {
        version: 1,
        startDate: '2027-03-01',
      });
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('YEAR_OVERLAP');
      const order = await call('patch', `${YEARS}/${one.id}`, {
        version: 1,
        endDate: '2026-06-01',
      });
      expect(order.status).toBe(400);
      const taken = await call('patch', `${YEARS}/${two.id}`, { version: 1, name: '2026-2027' });
      expect(taken.body.errors?.[0]).toMatchObject({ field: 'name', code: 'DUPLICATE' });
      const flag = await call('patch', `${YEARS}/${two.id}`, { version: 1, isCurrent: true });
      expect(flag.body.errors?.[0]).toMatchObject({
        field: 'isCurrent',
        code: 'FIELD_NOT_ALLOWED',
      });
      expect((await years(first)).map((year) => year.version)).toEqual([1, 1]);
    });

    it('is 404 for a year of another Society, an Institution out of scope, or an unknown or malformed ID', async () => {
      const foreign = await added(other, {}, otherOwner.token);
      const outOfScope = await added(second);
      for (const [id, token] of [
        [foreign.id, owner.token],
        [outOfScope.id, institutionAdmin.token],
        [missing, owner.token],
        ['nope', owner.token],
      ] as const) {
        expect(
          (await call('patch', `${YEARS}/${id}`, { version: 1, name: 'x' }, token)).status,
        ).toBe(404);
      }
      expect((await years(other, otherOwner.token))[0]!.name).toBe('2026-2027');
    });
  });

  describe('AY-04 make a year current', () => {
    it('swaps the current year in one step, and audits who it replaced', async () => {
      const one = await added(first);
      const two = await added(first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      const res = await call('post', `${YEARS}/${two.id}/make-current`, { version: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ isCurrent: true, version: 2 });
      const all = await years(first);
      expect(all.filter((year) => year.isCurrent).map((year) => year.id)).toEqual([two.id]);
      expect(all.find((year) => year.id === one.id)!.version).toBe(2);

      expect((await audit(two.id)).at(-1)).toMatchObject({
        action: 'academic_year.made_current',
        old_values: { is_current: false },
        new_values: { is_current: true, previous_year_id: one.id },
      });
    });

    it('writes nothing when the year is already current, and refuses a stale version', async () => {
      const one = await added(first);
      const already = await call('post', `${YEARS}/${one.id}/make-current`, { version: 1 });
      expect(already.status).toBe(200);
      expect(already.body.data.version).toBe(1);
      expect(await audit(one.id)).toHaveLength(1);

      const stale = await call('post', `${YEARS}/${one.id}/make-current`, { version: 5 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect((await call('post', `${YEARS}/${one.id}/make-current`, {})).status).toBe(400);
    });

    it('never leaves two current years, and never answers 5xx, when asked several times at once', async () => {
      await added(first);
      const later = await Promise.all(
        [2027, 2028, 2029, 2030].map((from) =>
          added(first, {
            name: `${from}-${from + 1}`,
            startDate: `${from}-06-01`,
            endDate: `${from + 1}-03-31`,
          }),
        ),
      );
      const answers = await Promise.all(
        later.map((year) => call('post', `${YEARS}/${year.id}/make-current`, { version: 1 })),
      );
      for (const answer of answers) expect([200, 409]).toContain(answer.status);
      expect((await years(first)).filter((year) => year.isCurrent)).toHaveLength(1);
    });

    it('is 404 for a deactivated year and for another Society’s', async () => {
      await added(first);
      const two = await added(first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      await call('delete', `${YEARS}/${two.id}`);
      expect((await call('post', `${YEARS}/${two.id}/make-current`, { version: 2 })).status).toBe(
        404,
      );
      const foreign = await added(other, {}, otherOwner.token);
      expect(
        (await call('post', `${YEARS}/${foreign.id}/make-current`, { version: 1 })).status,
      ).toBe(404);
    });
  });

  describe('AY-05 deactivate a year', () => {
    it('deactivates one that is not current, keeps the row, and frees its name and dates', async () => {
      await added(first);
      const two = await added(first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      const res = await call('delete', `${YEARS}/${two.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: two.id, status: 0 });
      expect(await years(first)).toHaveLength(1);

      const kept = await database.transaction(
        { personId: owner.person, roleCode: 2, societyId: societyA, institutionIds: [first] },
        (tx) => tx.selectFrom('academic_years').select('status').where('id', '=', two.id).execute(),
      );
      expect(kept).toEqual([{ status: 0 }]);
      expect((await audit(two.id)).at(-1)).toMatchObject({
        action: 'academic_year.deactivated',
        old_values: { status: 1 },
        new_values: { status: 0 },
      });

      const again = await add(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      expect(again.status).toBe(201);
      expect((await call('delete', `${YEARS}/${two.id}`)).status).toBe(404);
    });

    it('refuses the current year with 409 CURRENT_YEAR_LOCKED, and writes nothing', async () => {
      const one = await added(first);
      const res = await call('delete', `${YEARS}/${one.id}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CURRENT_YEAR_LOCKED');
      expect(await years(first)).toHaveLength(1);
      expect(await audit(one.id)).toHaveLength(1);
    });

    it('is 404 for a year of another Society or out of scope, and the Admin may deactivate in theirs', async () => {
      const foreign = await added(other, {}, otherOwner.token);
      expect((await call('delete', `${YEARS}/${foreign.id}`)).status).toBe(404);
      await added(first);
      const two = await added(first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      expect((await call('delete', `${YEARS}/${two.id}`, {}, institutionAdmin.token)).status).toBe(
        200,
      );
    });
  });

  describe('the database itself', () => {
    it('keeps one Society’s years from another’s, and from a caller with no scope', async () => {
      const year = await added(first);
      const seenByOther = await database.transaction(
        { personId: otherOwner.person, roleCode: 2, societyId: societyB, institutionIds: [other] },
        (tx) => tx.selectFrom('academic_years').select('id').execute(),
      );
      expect(seenByOther).toEqual([]);
      const seenByNobody = await database.transaction(
        { personId: owner.person, roleCode: 2 },
        (tx) => tx.selectFrom('academic_years').select('id').execute(),
      );
      expect(seenByNobody).toEqual([]);
      const seenByOwner = await database.transaction(
        { personId: owner.person, roleCode: 2, societyId: societyA, institutionIds: [first] },
        (tx) => tx.selectFrom('academic_years').select('id').execute(),
      );
      expect(seenByOwner).toEqual([{ id: year.id }]);
    });

    it('refuses to deactivate the current year even past the application', async () => {
      const year = await added(first);
      await expect(
        database.transaction(
          { personId: owner.person, roleCode: 2, societyId: societyA, institutionIds: [first] },
          (tx) =>
            tx.updateTable('academic_years').set({ status: 0 }).where('id', '=', year.id).execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses a second current year past the application', async () => {
      await added(first);
      const two = await added(first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      await expect(
        database.transaction(
          { personId: owner.person, roleCode: 2, societyId: societyA, institutionIds: [first] },
          (tx) =>
            tx
              .updateTable('academic_years')
              .set({ is_current: true })
              .where('id', '=', two.id)
              .execute(),
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: 'uq_academic_years_current' });
    });

    it('shows a scope that holds one Institution none of the years of its sibling', async () => {
      const year = await added(first);
      const sibling = await added(second);
      const onlySecond = await database.transaction(
        { personId: owner.person, roleCode: 2, societyId: societyA, institutionIds: [second] },
        (tx) => tx.selectFrom('academic_years').select('id').execute(),
      );
      expect(onlySecond).toEqual([{ id: sibling.id }]);
      expect(onlySecond).not.toContainEqual({ id: year.id });
    });

    it('has no delete right', async () => {
      const year = await added(first);
      await expect(
        database.transaction(
          { personId: owner.person, roleCode: 2, societyId: societyA, institutionIds: [first] },
          (tx) => tx.deleteFrom('academic_years').where('id', '=', year.id).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
