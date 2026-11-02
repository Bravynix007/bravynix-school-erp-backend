import { Kysely, PostgresDialect, sql } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
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
import { removeScratchMasters } from '../support/scratch-masters.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

interface Entry {
  id: string;
  code: string;
  name: string;
  [field: string]: unknown;
}

interface Institution {
  id: string;
  version: number;
  address: Record<string, unknown>;
  classesOffered: { id: string; code: string; name: string }[];
}

describe('INS-02 to INS-04 the place and the classes offered (API design 10.4c)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  let societyId: string;
  let owner: SignedInPerson;
  const societies: string[] = [];
  const scratch: { table: string; id: string }[] = [];

  /** The seeded masters the tests pick from. */
  let categories: Entry[];
  let karnataka: Entry;
  let maharashtra: Entry;
  let india: Entry;
  let bengaluru: Entry;
  let pune: Entry;

  const masters = async (type: string, query = '') => {
    const res = await api('get', `/v1/masters/${type}${query}`, admin);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Entry[];
  };
  const category = (code: string) => categories.find((c) => c.code === code)!;

  const make = (fields: object = {}) =>
    api('post', '/v1/institutions', owner.token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
      ...fields,
    });
  const made = async (fields: object = {}) => {
    const res = await make(fields);
    expect(res.status).toBe(201);
    return res.body.data as unknown as Institution;
  };
  const patch = (id: string, body: object) =>
    api('patch', `/v1/institutions/${id}`, owner.token, body);
  const read = async (id: string, token = owner.token) => {
    const res = await api('get', `/v1/institutions/${id}`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Institution;
  };
  const offeredRows = async (institutionId: string) =>
    (
      await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`alter table institution_class_categories no force row level security`.execute(tx);
        return sql<{ class_category_id: string }>`
          select class_category_id from institution_class_categories where institution_id = ${institutionId}
        `.execute(tx);
      })
    ).rows.map((row) => row.class_category_id);
  const scratchEntry = async (type: string, table: string, body: object) => {
    const res = await api('post', `/v1/platform/masters/${type}`, admin, body);
    expect(res.status).toBe(201);
    const entry = res.body.data as unknown as Entry;
    scratch.push({ table, id: entry.id });
    return entry;
  };
  const audit = (institutionId: string) =>
    readAuditRows<{
      action: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`institution_id = ${institutionId}`);

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
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    societyId = res.body.data.id;
    societies.push(societyId);
    owner = await fixtures.owner(societyId);
    categories = await masters('class-categories');
    india = (await masters('countries'))[0]!;
    const states = await masters('states', `?countryId=${india.id}`);
    karnataka = states.find((s) => s.iso2 === 'KA')!;
    maharashtra = states.find((s) => s.iso2 === 'MH')!;
    bengaluru = (await masters('cities', `?stateId=${karnataka.id}`)).find(
      (c) => c.name === 'Bengaluru',
    )!;
    pune = (await masters('cities', `?stateId=${maharashtra.id}`)).find((c) => c.name === 'Pune')!;
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    await fixtures.cleanup();
    await removeScratchMasters(ownerDb, scratch.splice(0));
  });

  describe('INS-02 add an Institution', () => {
    it('keeps the place and the classes offered, shows them in the master order, and audits them', async () => {
      const wanted = [category('HIGH_SCHOOL'), category('LOWER_PRIMARY')];
      const created = await made({
        address: {
          line1: '12 Lake Road',
          countryId: india.id,
          stateId: karnataka.id,
          cityId: bengaluru.id,
        },
        classesOffered: wanted.map((c) => c.id),
      });
      expect(created.address).toEqual({
        line1: '12 Lake Road',
        line2: null,
        pincode: null,
        countryId: india.id,
        stateId: karnataka.id,
        cityId: bengaluru.id,
      });
      expect(created.classesOffered).toEqual([
        { id: category('LOWER_PRIMARY').id, code: 'LOWER_PRIMARY', name: 'Lower Primary' },
        { id: category('HIGH_SCHOOL').id, code: 'HIGH_SCHOOL', name: 'High School' },
      ]);
      expect(await read(created.id)).toEqual(created);

      const [entry, ...rest] = await audit(created.id);
      expect(rest).toEqual([]);
      expect(entry!.new_values).toMatchObject({
        country_id: india.id,
        state_id: karnataka.id,
        city_id: bengaluru.id,
        classes_offered: [category('LOWER_PRIMARY').id, category('HIGH_SCHOOL').id],
      });
    });

    it('offers nothing and names no place when none is given', async () => {
      const created = await made();
      expect(created.classesOffered).toEqual([]);
      expect(created.address).toMatchObject({ countryId: null, stateId: null, cityId: null });
    });

    it('accepts a country alone, or a country and a state', async () => {
      const country = await made({ address: { line1: 'a', countryId: india.id } });
      expect(country.address).toMatchObject({ countryId: india.id, stateId: null });
      const state = await made({
        address: { line1: 'a', countryId: india.id, stateId: karnataka.id },
      });
      expect(state.address).toMatchObject({ stateId: karnataka.id, cityId: null });
    });

    it('refuses a place that is not a chain, or whose parts do not fit, and writes nothing', async () => {
      const cases: [object, string, string][] = [
        [{ stateId: karnataka.id }, 'address.countryId', 'REQUIRED'],
        [{ countryId: india.id, cityId: bengaluru.id }, 'address.stateId', 'REQUIRED'],
        [
          { countryId: india.id, stateId: karnataka.id, cityId: pune.id },
          'address.cityId',
          'INVALID_VALUE',
        ],
        [{ countryId: 'nope' }, 'address.countryId', 'INVALID_FORMAT'],
      ];
      for (const [place, field, code] of cases) {
        const res = await make({ address: { line1: 'a', ...place } });
        expect(res.status).toBe(400);
        expect(res.body.errors?.[0]).toMatchObject({ field, code });
      }
      const other = await scratchEntry('countries', 'countries', {
        name: `Scratch ${newId().slice(-6)}`,
        iso2: 'ZX',
      });
      const wrongCountry = await make({
        address: { line1: 'a', countryId: other.id, stateId: karnataka.id },
      });
      expect(wrongCountry.status).toBe(400);
      expect(wrongCountry.body.errors?.[0]).toMatchObject({
        field: 'address.stateId',
        code: 'INVALID_VALUE',
      });

      const unknown = await make({ address: { line1: 'a', countryId: missing } });
      expect(unknown.status).toBe(404);
      const list = await api('get', '/v1/institutions', owner.token);
      expect(list.body.data).toEqual([]);
    });

    it('refuses a hidden place with 422 REFERENCE_INACTIVE on the field', async () => {
      const country = await scratchEntry('countries', 'countries', {
        name: `Scratch ${newId().slice(-6)}`,
        iso2: 'ZY',
      });
      const state = await scratchEntry('states', 'states', {
        countryId: country.id,
        name: `State ${newId().slice(-6)}`,
      });
      expect((await api('delete', `/v1/platform/masters/states/${state.id}`, admin)).status).toBe(
        200,
      );
      const res = await make({
        address: { line1: 'a', countryId: country.id, stateId: state.id },
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('REFERENCE_INACTIVE');
      expect(res.body.errors?.[0]).toMatchObject({ field: 'address.stateId' });
    });

    it('refuses classes offered that are unknown, hidden, repeated, too many or not IDs, writing nothing', async () => {
      const hidden = await scratchEntry('class-categories', 'class_categories', {
        code: `T${newId().slice(-8).toUpperCase()}`,
        name: `Scratch ${newId().slice(-6)}`,
      });
      expect(
        (await api('delete', `/v1/platform/masters/class-categories/${hidden.id}`, admin)).status,
      ).toBe(200);
      const first = category('LOWER_PRIMARY').id;

      expect((await make({ classesOffered: [first, missing] })).status).toBe(404);
      const inactive = await make({ classesOffered: [first, hidden.id] });
      expect(inactive.status).toBe(422);
      expect(inactive.body.errors?.[0]).toMatchObject({
        field: 'classesOffered[1]',
        code: 'REFERENCE_INACTIVE',
      });
      for (const [value, code] of [
        [[first, first], 'INVALID_VALUE'],
        [['nope'], 'INVALID_FORMAT'],
        [null, 'INVALID_TYPE'],
        ['all', 'INVALID_TYPE'],
        [Array.from({ length: 51 }, () => newId()), 'TOO_MANY'],
      ] as const) {
        const res = await make({ classesOffered: value });
        expect(res.status).toBe(400);
        expect(res.body.errors?.[0]).toMatchObject({ field: 'classesOffered', code });
      }
      const list = await api('get', '/v1/institutions', owner.token);
      expect(list.body.data).toEqual([]);
    });
  });

  describe('INS-04 change the place and the classes offered', () => {
    it('replaces the list: ticks one, unticks another, bumps the version and audits before and after', async () => {
      const created = await made({
        classesOffered: [category('PRE_SCHOOL').id, category('NURSERY').id],
      });
      const res = await patch(created.id, {
        version: 1,
        classesOffered: [category('NURSERY').id, category('HIGH_SCHOOL').id],
      });
      expect(res.status).toBe(200);
      const changed = res.body.data as unknown as Institution;
      expect(changed.version).toBe(2);
      expect(changed.classesOffered.map((c) => c.code)).toEqual(['NURSERY', 'HIGH_SCHOOL']);
      expect(await offeredRows(created.id)).toHaveLength(2);

      const rows = await audit(created.id);
      expect(rows.at(-1)).toMatchObject({
        action: 'institution.update',
        old_values: { classes_offered: [category('PRE_SCHOOL').id, category('NURSERY').id] },
        new_values: { classes_offered: [category('NURSERY').id, category('HIGH_SCHOOL').id] },
      });
    });

    it('leaves them alone when the field is left out, and clears them with an empty list', async () => {
      const created = await made({ classesOffered: [category('LOWER_PRIMARY').id] });
      const renamed = await patch(created.id, { version: 1, name: 'Renamed' });
      expect((renamed.body.data as unknown as Institution).classesOffered).toHaveLength(1);
      const cleared = await patch(created.id, { version: 2, classesOffered: [] });
      expect((cleared.body.data as unknown as Institution).classesOffered).toEqual([]);
      expect(await offeredRows(created.id)).toEqual([]);
    });

    it('writes nothing when the same classes come back in another order', async () => {
      const both = [category('LOWER_PRIMARY').id, category('HIGH_SCHOOL').id];
      const created = await made({ classesOffered: both });
      const res = await patch(created.id, { version: 1, classesOffered: both.toReversed() });
      expect(res.status).toBe(200);
      expect((res.body.data as unknown as Institution).version).toBe(1);
      expect(await audit(created.id)).toHaveLength(1);
    });

    it('treats a change of the classes alone as a change of the Institution', async () => {
      const created = await made();
      const res = await patch(created.id, { version: 1, classesOffered: [category('NURSERY').id] });
      expect((res.body.data as unknown as Institution).version).toBe(2);
      const stale = await patch(created.id, { version: 1, classesOffered: [] });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect(await offeredRows(created.id)).toEqual([category('NURSERY').id]);
    });

    it('refuses a bad list and keeps the old one', async () => {
      const created = await made({ classesOffered: [category('NURSERY').id] });
      for (const classesOffered of [[missing], [category('NURSERY').id, missing], null]) {
        const res = await patch(created.id, { version: 1, classesOffered });
        expect([400, 404]).toContain(res.status);
      }
      expect(await offeredRows(created.id)).toEqual([category('NURSERY').id]);
      expect((await read(created.id)).version).toBe(1);
    });

    it('moves the place with the address, as a whole, and clears it when the address names none', async () => {
      const created = await made({
        address: { line1: 'a', countryId: india.id, stateId: karnataka.id, cityId: bengaluru.id },
      });
      const moved = await patch(created.id, {
        version: 1,
        address: { line1: 'a', countryId: india.id, stateId: maharashtra.id, cityId: pune.id },
      });
      expect((moved.body.data as unknown as Institution).address).toMatchObject({
        stateId: maharashtra.id,
        cityId: pune.id,
      });
      const bad = await patch(created.id, {
        version: 2,
        address: { line1: 'a', countryId: india.id, stateId: karnataka.id, cityId: pune.id },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.errors?.[0]).toMatchObject({ field: 'address.cityId' });
      const cleared = await patch(created.id, { version: 2, address: { line1: 'a' } });
      expect((cleared.body.data as unknown as Institution).address).toMatchObject({
        countryId: null,
        stateId: null,
        cityId: null,
      });
    });

    it('names the position of a hidden category in the request when the list also holds one the Institution has', async () => {
      const kept = category('NURSERY').id;
      const created = await made({ classesOffered: [kept] });
      const hidden = await scratchEntry('class-categories', 'class_categories', {
        code: `T${newId().slice(-8).toUpperCase()}`,
        name: `Scratch ${newId().slice(-6)}`,
      });
      await api('delete', `/v1/platform/masters/class-categories/${hidden.id}`, admin);
      const res = await patch(created.id, { version: 1, classesOffered: [kept, hidden.id] });
      expect(res.status).toBe(422);
      expect(res.body.errors?.[0]).toMatchObject({
        field: 'classesOffered[1]',
        code: 'REFERENCE_INACTIVE',
      });
      expect(await offeredRows(created.id)).toEqual([kept]);
    });

    it('changes only the city while the stored state is hidden, checking only the new city', async () => {
      const country = await scratchEntry('countries', 'countries', {
        name: `Scratch ${newId().slice(-6)}`,
        iso2: 'ZW',
      });
      const state = await scratchEntry('states', 'states', {
        countryId: country.id,
        name: `State ${newId().slice(-6)}`,
      });
      const city = await scratchEntry('cities', 'cities', {
        stateId: state.id,
        name: `City ${newId().slice(-6)}`,
      });
      const place = { countryId: country.id, stateId: state.id };
      const created = await made({ address: { line1: 'a', ...place } });
      await api('delete', `/v1/platform/masters/states/${state.id}`, admin);
      const res = await patch(created.id, {
        version: 1,
        address: { line1: 'a', ...place, cityId: city.id },
      });
      expect(res.status).toBe(200);
      expect((res.body.data as unknown as Institution).address).toMatchObject({ cityId: city.id });
    });

    it('accepts IDs in upper case, as the path does, and still sees a repeat in another case', async () => {
      const nursery = category('NURSERY').id;
      const created = await made({
        address: {
          line1: 'a',
          countryId: india.id.toUpperCase(),
          stateId: karnataka.id.toUpperCase(),
        },
        classesOffered: [nursery.toUpperCase()],
      });
      expect(created.address).toMatchObject({ countryId: india.id, stateId: karnataka.id });
      expect(created.classesOffered.map((c) => c.id)).toEqual([nursery]);
      const twice = await patch(created.id, {
        version: 1,
        classesOffered: [nursery, nursery.toUpperCase()],
      });
      expect(twice.status).toBe(400);
      expect(twice.body.errors?.[0]).toMatchObject({ field: 'classesOffered' });
    });

    it('keeps a place the Institution already has after its entry is hidden, and refuses it as a new link', async () => {
      const country = await scratchEntry('countries', 'countries', {
        name: `Scratch ${newId().slice(-6)}`,
        iso2: 'ZW',
      });
      const state = await scratchEntry('states', 'states', {
        countryId: country.id,
        name: `State ${newId().slice(-6)}`,
      });
      const place = { countryId: country.id, stateId: state.id };
      const created = await made({ address: { line1: 'a', ...place } });
      await api('delete', `/v1/platform/masters/states/${state.id}`, admin);

      const kept = await patch(created.id, {
        version: 1,
        address: { line1: 'b', line2: 'Near the lake', ...place },
      });
      expect(kept.status).toBe(200);
      expect((kept.body.data as unknown as Institution).address).toMatchObject({
        line1: 'b',
        stateId: state.id,
      });
      const fresh = await made();
      const refused = await patch(fresh.id, { version: 1, address: { line1: 'a', ...place } });
      expect(refused.status).toBe(422);
      expect(refused.body.errors?.[0]).toMatchObject({ field: 'address.stateId' });
    });

    it('shows the classes offered to an Institution Admin of that Institution, and none to anyone else', async () => {
      const created = await made({ classesOffered: [category('NURSERY').id] });
      const adminOf = await fixtures.institutionAdmin(societyId, [created.id]);
      expect((await read(created.id, adminOf.token)).classesOffered).toHaveLength(1);

      const otherSociety = await api('post', '/v1/platform/societies', admin, {
        name: 'Other Trust',
        code: `S${newId().slice(-12)}`,
      });
      societies.push(otherSociety.body.data.id);
      const stranger = await fixtures.owner(otherSociety.body.data.id);
      expect((await api('get', `/v1/institutions/${created.id}`, stranger.token)).status).toBe(404);
    });

    it('is not for Super Admin or an Admin to change, and PLT-45 shows the place and the classes', async () => {
      const created = await made({
        address: { line1: 'a', countryId: india.id },
        classesOffered: [category('NURSERY').id],
      });
      const adminOf = await fixtures.institutionAdmin(societyId, [created.id]);
      for (const token of [admin, adminOf.token]) {
        const res = await api('patch', `/v1/institutions/${created.id}`, token, {
          version: 1,
          classesOffered: [],
        });
        expect(res.status).toBe(403);
      }
      const seen = await api('get', `/v1/platform/institutions/${created.id}`, admin);
      expect(seen.status).toBe(200);
      expect(seen.body.data.address).toMatchObject({ countryId: india.id });
      expect(seen.body.data.classesOffered).toEqual([
        { id: category('NURSERY').id, code: 'NURSERY', name: expect.any(String) },
      ]);
    });
  });

  describe('the database', () => {
    it('gives the app role insert, select and delete on the classes offered, and no update', async () => {
      const { rows } = await sql<{ privilege: string; app_can: boolean }>`
        select p.privilege, has_table_privilege('erp_app', 'institution_class_categories', p.privilege) as app_can
        from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p (privilege)
        order by p.privilege
      `.execute(ownerDb);
      expect(rows).toEqual([
        { privilege: 'DELETE', app_can: true },
        { privilege: 'INSERT', app_can: true },
        { privilege: 'SELECT', app_can: true },
        { privilege: 'TRUNCATE', app_can: false },
        { privilege: 'UPDATE', app_can: false },
      ]);
    });

    it('refuses a state without a country, and a city without a state, whoever writes it', async () => {
      const created = await made();
      for (const [column, value] of [
        ['state_id', karnataka.id],
        ['city_id', bengaluru.id],
      ] as const) {
        const attempt = ownerDb.transaction().execute(async (tx) => {
          await sql`select set_config('app.role_code', '1', true)`.execute(tx);
          await sql`update institutions set ${sql.ref(column)} = ${value} where id = ${created.id}`.execute(
            tx,
          );
        });
        await expect(attempt).rejects.toMatchObject({
          constraint: 'ck_institutions_place_chain',
        });
      }
    });
  });
});
