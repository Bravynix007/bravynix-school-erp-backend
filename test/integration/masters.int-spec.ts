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
import { removeScratchMasters } from '../support/scratch-masters.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

const code = () => `T${newId().slice(-10).toUpperCase().replaceAll('-', '')}`;
const name = () => `Scratch ${newId().slice(-8)}`;
const short = () => newId().slice(-8).toUpperCase();
const sectionBody = () => ({ code: `C${short()}`, name: `N${short()}`.slice(0, 10) });

type Method = 'get' | 'post' | 'patch' | 'delete';

interface Entry {
  id: string;
  status: number;
  version: number;
  [field: string]: unknown;
}

describe('MST-01 and PLT-31 to PLT-33 platform masters (API design 10.4g, DDD 9.2)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  let societyId: string;
  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  const scratch: { table: string; id: string }[] = [];

  const asAdmin = (method: Method, path: string, body: object = {}) =>
    api(method, path, admin, body);

  const list = async (type: string, query = '', token = admin) => {
    const res = await api('get', `/v1/masters/${type}${query}`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Entry[];
  };

  const created = async (type: string, table: string, body: object): Promise<Entry> => {
    const res = await asAdmin('post', `/v1/platform/masters/${type}`, body);
    expect(res.status).toBe(201);
    const entry = res.body.data as unknown as Entry;
    scratch.push({ table, id: entry.id });
    return entry;
  };

  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      society_id: string | null;
      institution_id: string | null;
      entity_type: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);

  const idOf = async (type: string, key: string, value: string) =>
    (await list(type, '?includeHidden=true')).find((entry) => entry[key] === value)!.id;

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
    const res = await asAdmin('post', '/v1/platform/societies', {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    societyId = res.body.data.id;
    owner = await fixtures.owner(societyId);
    const institution = await api('post', '/v1/institutions', owner.token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
    });
    institutionAdmin = await fixtures.institutionAdmin(societyId, [institution.body.data.id]);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, [societyId]);
    await fixtures.cleanup();
    await removeScratchMasters(ownerDb, scratch.splice(0));
  });

  describe('what is seeded', () => {
    it('has the seven class categories of the Indian school system, in order', async () => {
      const categories = await list('class-categories');
      expect(categories.map((c) => [c.displayOrder, c.code, c.name])).toEqual([
        [1, 'PRE_SCHOOL', 'Pre-School'],
        [2, 'NURSERY', 'Nursery'],
        [3, 'LOWER_PRIMARY', 'Lower Primary'],
        [4, 'HIGHER_PRIMARY', 'Higher Primary'],
        [5, 'HIGH_SCHOOL', 'High School'],
        [6, 'SENIOR_SECONDARY', 'Senior Secondary'],
        [7, 'PRE_UNIVERSITY', 'Pre-University'],
      ]);
    });

    it('lists the predefined classes in promotion order, each in its category', async () => {
      const classes = await list('predefined-classes');
      const categories = await list('class-categories');
      const nameOf = (id: unknown) => categories.find((c) => c.id === id)!.code;
      expect(classes.map((c) => [c.name, nameOf(c.classCategoryId)])).toEqual([
        ['Nursery', 'PRE_SCHOOL'],
        ['LKG', 'NURSERY'],
        ['UKG', 'NURSERY'],
        ...['1st', '2nd', '3rd', '4th'].map((n) => [n, 'LOWER_PRIMARY']),
        ...['5th', '6th', '7th', '8th'].map((n) => [n, 'HIGHER_PRIMARY']),
        ['9th', 'HIGH_SCHOOL'],
        ['10th', 'HIGH_SCHOOL'],
        ['11th', 'SENIOR_SECONDARY'],
        ['12th', 'SENIOR_SECONDARY'],
        ['PUC 1st Year', 'PRE_UNIVERSITY'],
        ['PUC 2nd Year', 'PRE_UNIVERSITY'],
      ]);
      expect(classes.map((c) => c.displayOrder)).toEqual(
        Array.from({ length: classes.length }, (_, i) => i + 1),
      );
    });

    it('filters the predefined classes by category', async () => {
      const senior = await idOf('class-categories', 'code', 'SENIOR_SECONDARY');
      const classes = await list('predefined-classes', `?classCategoryId=${senior}`);
      expect(classes.map((c) => c.name)).toEqual(['11th', '12th']);
    });

    it('has the sections A to J and the designations', async () => {
      expect((await list('predefined-sections')).map((s) => s.name)).toEqual([...'ABCDEFGHIJ']);
      const designations = (await list('designations')).map((d) => d.name);
      expect(designations).toEqual(expect.arrayContaining(['Principal', 'Teacher', 'Librarian']));
    });

    it('has India, its states and union territories, and their main cities', async () => {
      const countries = await list('countries');
      expect(countries).toHaveLength(1);
      expect(countries[0]).toMatchObject({
        name: 'India',
        iso2: 'IN',
        phoneCode: '91',
        currency: 'INR',
      });
      const states = await list('states', `?countryId=${countries[0]!.id}`);
      expect(states).toHaveLength(36);
      const karnataka = states.find((s) => s.iso2 === 'KA')!;
      const cities = (await list('cities', `?stateId=${karnataka.id}`)).map((c) => c.name);
      expect(cities).toEqual(expect.arrayContaining(['Bengaluru', 'Mysuru']));
    });
  });

  describe('MST-01 who may read, and how', () => {
    it('is read by every role that can sign in, and by no one who has not', async () => {
      for (const token of [admin, owner.token, institutionAdmin.token]) {
        expect((await list('designations', '', token)).length).toBeGreaterThan(0);
      }
      await request(t.app.getHttpServer()).get('/v1/masters/designations').expect(401);
    });

    it('answers 404 for a master that does not exist', async () => {
      const res = await api('get', '/v1/masters/subjects', admin);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('needs the state for a list of cities, and refuses a filter the master has not', async () => {
      const noState = await api('get', '/v1/masters/cities', admin);
      expect(noState.status).toBe(400);
      expect(noState.body.errors).toEqual([
        expect.objectContaining({ field: 'stateId', code: 'REQUIRED' }),
      ]);

      const wrong = await api('get', `/v1/masters/designations?countryId=${missing}`, admin);
      expect(wrong.status).toBe(400);
      expect(wrong.body.errors).toEqual([
        expect.objectContaining({ field: 'countryId', code: 'FIELD_NOT_ALLOWED' }),
      ]);

      const malformed = await api('get', '/v1/masters/cities?stateId=nope', admin);
      expect(malformed.status).toBe(400);
      expect(malformed.body.errors?.[0]).toMatchObject({
        field: 'stateId',
        code: 'INVALID_FORMAT',
      });
    });

    it('lets the app keep a list five minutes and revalidate it with the tag', async () => {
      const first = await api('get', '/v1/masters/class-categories', owner.token);
      expect(first.headers['cache-control']).toBe('private, max-age=300');
      expect(first.headers['vary']).toBe('Origin, Authorization');
      const etag = first.headers['etag'] as string;
      // Express answers 304 from the tag set here, whichever form of it the app sends back.
      for (const sent of [etag, etag.replace(/^W\//, ''), '*']) {
        const revalidated = await request(t.app.getHttpServer())
          .get('/v1/masters/class-categories')
          .set('Authorization', `Bearer ${owner.token}`)
          .set('If-None-Match', sent);
        expect(revalidated.status).toBe(304);
      }
      expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);

      const again = await request(t.app.getHttpServer())
        .get('/v1/masters/class-categories')
        .set('Authorization', `Bearer ${owner.token}`)
        .set('If-None-Match', etag);
      expect(again.status).toBe(304);
      expect(again.text).toBe('');
      expect(again.headers['etag']).toBe(etag);

      // The same entries have the same tag for everyone.
      const other = await api('get', '/v1/masters/class-categories', institutionAdmin.token);
      expect(other.headers['etag']).toBe(etag);

      // A change gives a new tag, and the old one now gets the list again.
      await created('class-categories', 'class_categories', { code: code(), name: name() });
      const changed = await request(t.app.getHttpServer())
        .get('/v1/masters/class-categories')
        .set('Authorization', `Bearer ${owner.token}`)
        .set('If-None-Match', etag);
      expect(changed.status).toBe(200);
      expect(changed.headers['etag']).not.toBe(etag);
      expect(changed.body.data).toHaveLength(8);
    });

    it('adds Authorization to the CORS Vary: Origin, and does not replace it', async () => {
      const res = await request(t.app.getHttpServer())
        .get('/v1/masters/class-categories')
        .set('Authorization', `Bearer ${owner.token}`)
        .set('Origin', 'http://localhost:3001');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001');
      const vary = String(res.headers['vary']).split(/,\s*/);
      expect(vary).toEqual(expect.arrayContaining(['Origin', 'Authorization']));
    });

    it('keeps hidden entries from everyone but Super Admin, who asks for them', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      expect(
        (await asAdmin('delete', `/v1/platform/masters/designations/${entry.id}`)).status,
      ).toBe(200);

      expect((await list('designations', '', owner.token)).some((d) => d.id === entry.id)).toBe(
        false,
      );
      expect((await list('designations')).some((d) => d.id === entry.id)).toBe(false);
      const all = await api('get', '/v1/masters/designations?includeHidden=true', admin);
      expect(all.headers['cache-control']).toBe('private, no-cache');
      expect((all.body.data as unknown as Entry[]).find((d) => d.id === entry.id)).toMatchObject({
        status: 0,
      });

      const refused = await api('get', '/v1/masters/designations?includeHidden=true', owner.token);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      expect((await api('get', '/v1/masters/designations?includeHidden=maybe', admin)).status).toBe(
        400,
      );
    });
  });

  describe('PLT-31 add an entry', () => {
    it('adds to the end of an ordered list, with its audit entry', async () => {
      const body = { code: code(), name: name() };
      const entry = await created('class-categories', 'class_categories', body);
      expect(entry).toMatchObject({ ...body, displayOrder: 8, status: 1, version: 1 });
      expect(entry).not.toHaveProperty('createdBy');
      expect(await list('class-categories')).toHaveLength(8);

      const [row, ...rest] = await audit(entry.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        action: 'platform.master.created',
        entity_type: 'class_category',
        actor_user_id: superAdmin.id,
        society_id: null,
        institution_id: null,
        old_values: null,
      });
      expect(row!.new_values).toMatchObject({ code: body.code, name: body.name, display_order: 8 });
    });

    it('inserts at a position and moves the entries from there down one', async () => {
      const before = await list('predefined-classes');
      const category = await idOf('class-categories', 'code', 'HIGH_SCHOOL');
      const entry = await created('predefined-classes', 'predefined_classes', {
        classCategoryId: category,
        code: code(),
        name: name(),
        numericValue: 99,
        displayOrder: 2,
      });
      expect(entry.displayOrder).toBe(2);
      const after = await list('predefined-classes');
      expect(after.map((c) => c.id)).toEqual([
        before[0]!.id,
        entry.id,
        ...before.slice(1).map((c) => c.id),
      ]);
      expect(after.map((c) => c.displayOrder)).toEqual(after.map((_, i) => i + 1));
    });

    it('refuses a position past the end, and writes nothing', async () => {
      const res = await asAdmin('post', '/v1/platform/masters/designations', {
        code: code(),
        name: name(),
        displayOrder: 99,
      });
      expect(res.status).toBe(400);
      expect(res.body.errors?.[0]).toMatchObject({
        field: 'displayOrder',
        code: 'OUT_OF_RANGE',
        params: { min: 1, max: 13 },
      });
      expect(await list('designations')).toHaveLength(12);
    });

    it('counts hidden entries: an entry added after a hidden one goes after it, not on top of it', async () => {
      const hidden = await created('designations', 'designations', { code: code(), name: name() });
      expect(hidden.displayOrder).toBe(13);
      expect(
        (await asAdmin('delete', `/v1/platform/masters/designations/${hidden.id}`)).status,
      ).toBe(200);
      const next = await created('designations', 'designations', { code: code(), name: name() });
      expect(next.displayOrder).toBe(14);
      const all = await list('designations', '?includeHidden=true');
      expect(all.map((entry) => entry.displayOrder)).toEqual(all.map((_, i) => i + 1));
    });

    it('keeps one list whole when adds, moves and a hide arrive together: no 5xx, positions 1 to N', async () => {
      const own = [];
      for (let i = 0; i < 4; i++) {
        own.push(await created('predefined-sections', 'predefined_sections', sectionBody()));
      }
      const base = '/v1/platform/masters/predefined-sections';
      const requests = [
        ...[1, 3, 5, 7, 9, 11].map((displayOrder) =>
          asAdmin('post', base, { ...sectionBody(), displayOrder }),
        ),
        ...own
          .slice(0, 3)
          .map((entry, i) =>
            asAdmin('patch', `${base}/${entry.id}`, { version: 1, displayOrder: 2 + i * 2 }),
          ),
        asAdmin('delete', `${base}/${own[3]!.id}`),
      ];
      const results = await Promise.all(requests);
      // Every entry that was added is queued for clean-up before anything is asserted, so a failure leaves nothing behind.
      const addedIds = results.filter((res) => res.status === 201).map((res) => res.body.data.id);
      for (const id of addedIds) scratch.push({ table: 'predefined_sections', id });
      const added = addedIds.length;
      for (const res of results) expect(res.status).toBeLessThan(500);
      expect(added).toBeGreaterThan(0);
      const all = await list('predefined-sections', '?includeHidden=true');
      expect(all).toHaveLength(10 + own.length + added);
      expect(all.map((entry) => entry.displayOrder)).toEqual(all.map((_, i) => i + 1));
    });

    it('lists the places by name, whatever the letter case and the order they were added in', async () => {
      const country = await created('countries', 'countries', {
        name: name(),
        iso2: 'ZY',
        phoneCode: '998',
        currency: 'ZZY',
      });
      for (const stateName of ['beta', 'Alpha', 'gamma']) {
        await created('states', 'states', { countryId: country.id, name: stateName });
      }
      const states = await list('states', `?countryId=${country.id}`);
      expect(states.map((state) => state.name)).toEqual(['Alpha', 'beta', 'gamma']);
      for (const cityName of ['delta', 'Charlie', 'bravo']) {
        await created('cities', 'cities', { stateId: states[0]!.id, name: cityName });
      }
      const cities = await list('cities', `?stateId=${states[0]!.id}`);
      expect(cities.map((city) => city.name)).toEqual(['bravo', 'Charlie', 'delta']);
    });

    it('adds places under their parent, by name', async () => {
      const country = await created('countries', 'countries', {
        name: name(),
        iso2: 'ZZ',
        phoneCode: '999',
        currency: 'ZZZ',
      });
      const state = await created('states', 'states', {
        countryId: country.id,
        name: 'Alpha State',
        iso2: 'AS',
      });
      const city = await created('cities', 'cities', { stateId: state.id, name: 'Alpha City' });
      expect(city).toMatchObject({ stateId: state.id, name: 'Alpha City' });
      expect(await list('cities', `?stateId=${state.id}`)).toHaveLength(1);
    });

    it('is 404 for a parent that does not exist and 422 for one that is hidden', async () => {
      const unknown = await asAdmin('post', '/v1/platform/masters/states', {
        countryId: missing,
        name: name(),
      });
      expect(unknown.status).toBe(404);

      const country = await created('countries', 'countries', { name: name(), iso2: 'ZY' });
      await asAdmin('delete', `/v1/platform/masters/countries/${country.id}`);
      const hidden = await asAdmin('post', '/v1/platform/masters/states', {
        countryId: country.id,
        name: name(),
      });
      expect(hidden.status).toBe(422);
      expect(hidden.body.code).toBe('REFERENCE_INACTIVE');
      expect(hidden.body.errors?.[0]).toMatchObject({ field: 'countryId' });
    });

    it('is 409 DUPLICATE on the field that is taken, whatever the letter case', async () => {
      const first = await created('class-categories', 'class_categories', {
        code: code(),
        name: 'Scratch Name',
      });
      const sameCode = await asAdmin('post', '/v1/platform/masters/class-categories', {
        code: first.code,
        name: name(),
      });
      expect(sameCode.status).toBe(409);
      expect(sameCode.body.errors?.[0]).toMatchObject({ field: 'code', code: 'DUPLICATE' });
      const sameName = await asAdmin('post', '/v1/platform/masters/class-categories', {
        code: code(),
        name: 'SCRATCH name',
      });
      expect(sameName.status).toBe(409);
      expect(sameName.body.errors?.[0]).toMatchObject({ field: 'name', code: 'DUPLICATE' });
      expect(await list('class-categories')).toHaveLength(8);

      const india = await asAdmin('post', '/v1/platform/masters/countries', {
        name: name(),
        iso2: 'IN',
      });
      expect(india.status).toBe(409);
      expect(india.body.errors?.[0]).toMatchObject({ field: 'iso2' });
    });

    it('treats names that differ only in the white space inside them as the same name', async () => {
      const base = name();
      await created('designations', 'designations', { code: code(), name: base });
      const res = await asAdmin('post', '/v1/platform/masters/designations', {
        code: code(),
        name: base.replace(' ', '  \t '),
      });
      expect(res.status).toBe(409);
      expect(res.body.errors?.[0]).toMatchObject({ field: 'name', code: 'DUPLICATE' });
    });

    it('names the field of every body error', async () => {
      const res = await asAdmin('post', '/v1/platform/masters/class-categories', {
        code: 'lower case',
        name: '',
        createdBy: superAdmin.id,
        displayOrder: '3',
      });
      expect(res.status).toBe(400);
      const fields = Object.fromEntries((res.body.errors ?? []).map((e) => [e.field, e.code]));
      expect(fields).toEqual({
        code: 'INVALID_FORMAT',
        name: 'TOO_SHORT',
        createdBy: 'FIELD_NOT_ALLOWED',
        displayOrder: 'INVALID_TYPE',
      });
    });

    it('is for Super Admin only, and an Owner or Admin changes nothing', async () => {
      for (const token of [owner.token, institutionAdmin.token]) {
        const res = await api('post', '/v1/platform/masters/designations', token, {
          code: code(),
          name: name(),
        });
        expect(res.status).toBe(403);
      }
      expect(await list('designations')).toHaveLength(12);
    });
  });

  describe('PLT-32 edit, move, hide and show', () => {
    it('edits the name with the version, bumps it, and audits before and after', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      const res = await asAdmin('patch', `/v1/platform/masters/designations/${entry.id}`, {
        version: 1,
        name: 'Renamed',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ name: 'Renamed', version: 2, code: entry.code });

      const rows = await audit(entry.id);
      expect(rows.map((r) => r.action)).toEqual([
        'platform.master.created',
        'platform.master.updated',
      ]);
      expect(rows[1]).toMatchObject({
        old_values: { name: entry.name },
        new_values: { name: 'Renamed' },
      });
    });

    it('answers a stale version with 409 and saves nothing', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      await asAdmin('patch', `/v1/platform/masters/designations/${entry.id}`, {
        version: 1,
        name: 'First',
      });
      const stale = await asAdmin('patch', `/v1/platform/masters/designations/${entry.id}`, {
        version: 1,
        name: 'Second',
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect(stale.body.data).toMatchObject({ currentVersion: 2 });
      expect(await audit(entry.id)).toHaveLength(2);
    });

    it('writes nothing when nothing changes', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      const res = await asAdmin('patch', `/v1/platform/masters/designations/${entry.id}`, {
        version: 1,
        name: entry.name,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ version: 1 });
      expect(await audit(entry.id)).toHaveLength(1);
    });

    it('refuses null for a field that cannot be empty: INVALID_TYPE, not a server error', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      const path = `/v1/platform/masters/designations/${entry.id}`;
      for (const field of ['name', 'status', 'displayOrder']) {
        const res = await asAdmin('patch', path, { version: 1, [field]: null });
        expect(res.status).toBe(400);
        expect(res.body.errors?.[0]).toMatchObject({ field, code: 'INVALID_TYPE' });
      }
      const add = await asAdmin('post', '/v1/platform/masters/designations', {
        code: code(),
        name: name(),
        displayOrder: null,
      });
      expect(add.status).toBe(400);
      expect(add.body.errors?.[0]).toMatchObject({ field: 'displayOrder', code: 'INVALID_TYPE' });
      expect((await list('designations')).find((d) => d.id === entry.id)!.version).toBe(1);
    });

    it('never changes a code, an ISO code or a parent, and needs the version', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      const path = `/v1/platform/masters/designations/${entry.id}`;
      const code422 = await asAdmin('patch', path, { version: 1, code: 'OTHER' });
      expect(code422.status).toBe(400);
      expect(code422.body.errors?.[0]).toMatchObject({ field: 'code', code: 'FIELD_NOT_ALLOWED' });
      const noVersion = await asAdmin('patch', path, { name: 'x' });
      expect(noVersion.status).toBe(400);
      expect(noVersion.body.errors?.[0]).toMatchObject({ field: 'version', code: 'INVALID_TYPE' });

      const india = await idOf('countries', 'iso2', 'IN');
      const state = await created('states', 'states', { countryId: india, name: name() });
      const moved = await asAdmin('patch', `/v1/platform/masters/states/${state.id}`, {
        version: 1,
        countryId: missing,
      });
      expect(moved.status).toBe(400);
      expect(moved.body.errors?.[0]).toMatchObject({ field: 'countryId' });
    });

    it('moves an entry and shifts the ones it passes, in either direction', async () => {
      const first = (await list('predefined-sections'))[0]!;
      const entry = await created('predefined-sections', 'predefined_sections', {
        code: code().slice(0, 10),
        name: name().slice(0, 10),
      });
      expect(entry.displayOrder).toBe(11);
      const orderOf = async () => (await list('predefined-sections')).map((s) => s.id);

      const up = await asAdmin('patch', `/v1/platform/masters/predefined-sections/${entry.id}`, {
        version: 1,
        displayOrder: 1,
      });
      expect(up.status).toBe(200);
      expect(up.body.data).toMatchObject({ displayOrder: 1, version: 2 });
      expect((await orderOf())[0]).toBe(entry.id);
      expect((await orderOf())[1]).toBe(first.id);

      const down = await asAdmin('patch', `/v1/platform/masters/predefined-sections/${entry.id}`, {
        version: 2,
        displayOrder: 4,
      });
      expect(down.status).toBe(200);
      const after = await list('predefined-sections');
      expect(after.map((s) => s.displayOrder)).toEqual(after.map((_, i) => i + 1));
      expect(after[3]!.id).toBe(entry.id);
      expect(after.slice(0, 3).map((s) => s.name)).toEqual(['A', 'B', 'C']);

      const rows = await audit(entry.id);
      expect(rows.at(-1)).toMatchObject({
        old_values: { display_order: 1 },
        new_values: { display_order: 4 },
      });
    });

    it('refuses a position outside the list', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      const res = await asAdmin('patch', `/v1/platform/masters/designations/${entry.id}`, {
        version: 1,
        displayOrder: 14,
      });
      expect(res.status).toBe(400);
      expect(res.body.errors?.[0]).toMatchObject({ field: 'displayOrder', code: 'OUT_OF_RANGE' });
    });

    it('hides and shows with status, each audited as its own action', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      const path = `/v1/platform/masters/designations/${entry.id}`;
      const hidden = await asAdmin('patch', path, { version: 1, status: 0 });
      expect(hidden.body.data).toMatchObject({ status: 0, version: 2 });
      const shown = await asAdmin('patch', path, { version: 2, status: 1 });
      expect(shown.body.data).toMatchObject({ status: 1, version: 3 });
      expect((await audit(entry.id)).map((r) => r.action)).toEqual([
        'platform.master.created',
        'platform.master.hidden',
        'platform.master.shown',
      ]);
      const bad = await asAdmin('patch', path, { version: 3, status: 2 });
      expect(bad.body.errors?.[0]).toMatchObject({ field: 'status', code: 'INVALID_CODE' });
    });

    it('is 404 for an unknown or malformed entry, and Super Admin only', async () => {
      for (const id of [missing, 'nope']) {
        expect(
          (await asAdmin('patch', `/v1/platform/masters/designations/${id}`, { version: 1 }))
            .status,
        ).toBe(404);
      }
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      const res = await api('patch', `/v1/platform/masters/designations/${entry.id}`, owner.token, {
        version: 1,
        name: 'Hijacked',
      });
      expect(res.status).toBe(403);
      expect((await list('designations')).find((d) => d.id === entry.id)!.name).toBe(entry.name);
    });
  });

  describe('PLT-33 hide an entry', () => {
    it('hides it, keeps the row, and audits it', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      const res = await asAdmin('delete', `/v1/platform/masters/designations/${entry.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: entry.id, status: 0 });
      const kept = await sql<{
        status: number;
      }>`select status from designations where id = ${entry.id}`.execute(ownerDb);
      expect(kept.rows).toEqual([{ status: 0 }]);
      expect((await audit(entry.id)).map((r) => r.action)).toEqual([
        'platform.master.created',
        'platform.master.hidden',
      ]);
    });

    it('is 409 INVALID_STATE when it is already hidden, and writes no second entry', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      await asAdmin('delete', `/v1/platform/masters/designations/${entry.id}`);
      const again = await asAdmin('delete', `/v1/platform/masters/designations/${entry.id}`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INVALID_STATE');
      expect(await audit(entry.id)).toHaveLength(2);
    });

    it('is Super Admin only, and an unknown entry is 404', async () => {
      const entry = await created('designations', 'designations', { code: code(), name: name() });
      for (const token of [owner.token, institutionAdmin.token]) {
        expect(
          (await api('delete', `/v1/platform/masters/designations/${entry.id}`, token)).status,
        ).toBe(403);
      }
      expect((await list('designations')).some((d) => d.id === entry.id)).toBe(true);
      expect((await asAdmin('delete', `/v1/platform/masters/designations/${missing}`)).status).toBe(
        404,
      );
    });
  });

  describe('the database itself', () => {
    it('lets the app role read but not write, unless the caller is Super Admin', async () => {
      const readOnly = { personId: owner.person, roleCode: 2 as const, societyId };
      const written = database.transaction(readOnly, (tx) =>
        tx.updateTable('designations').set({ name: 'Hijacked' }).execute(),
      );
      // A policy that admits no row leaves the update with nothing to change.
      await expect(written).resolves.toEqual([expect.objectContaining({ numUpdatedRows: 0n })]);
      await expect(
        database.transaction(readOnly, (tx) =>
          tx
            .insertInto('designations')
            .values({ name: 'X', code: 'X', display_order: 99 })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        database.transaction({ personId: superAdmin.id, roleCode: 1 }, (tx) =>
          tx.deleteFrom('designations').execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
