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

interface ClassBody {
  id: string;
  institutionId: string;
  predefinedClass: Entry;
  category: Entry;
  streamName: string | null;
  displayName: string;
  code: string | null;
  sectionCount: number;
  status: number;
  version: number;
}

interface SectionBody {
  id: string;
  classId: string;
  predefinedSection: Entry;
  displayName: string;
  capacity: number | null;
  currentStudentCount: null;
  classTeacher: null;
  status: number;
  version: number;
}

const tenantOf = (person: SignedInPerson, society: string, institutionIds: string[]) => ({
  personId: person.person,
  roleCode: 2,
  societyId: society,
  institutionIds,
});

describe('CLS-01 to CLS-05 and SEC-01 to SEC-04 classes and sections (PRD 7.3, API design 10.4j)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const scratch: { table: string; id: string }[] = [];

  /** Society A: the first Institution offers High School and Pre-University, the second offers nothing; the Admin has the first. */
  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let societyA: string;
  let first: string;
  let second: string;
  let other: string;
  let societyB: string;

  let categories: Entry[];
  let predefinedClasses: Entry[];
  let predefinedSections: Entry[];

  const category = (code: string) => categories.find((c) => c.code === code)!;
  const predefined = (code: string) => predefinedClasses.find((c) => c.code === code)!;
  const section = (code: string) => predefinedSections.find((s) => s.code === code)!;

  const masters = async (type: string) => {
    const res = await api('get', `/v1/masters/${type}`, admin);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Entry[];
  };

  const makeSociety = async () => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    societies.push(res.body.data.id);
    return res.body.data.id;
  };

  const makeInstitution = async (token: string, classesOffered: string[] = []) => {
    const res = await api('post', '/v1/institutions', token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
      classesOffered,
    });
    expect(res.status).toBe(201);
    return res.body.data.id;
  };

  const addClass = (institutionId: string, fields: object = {}, token = owner.token) =>
    api('post', '/v1/classes', token, {
      institutionId,
      predefinedClassId: predefined('C09').id,
      ...fields,
    });
  const classAdded = async (institutionId: string, fields: object = {}, token = owner.token) => {
    const res = await addClass(institutionId, fields, token);
    expect(res.status).toBe(201);
    return res.body.data as unknown as ClassBody;
  };
  const classes = async (institutionId: string, token = owner.token) => {
    const res = await api('get', `/v1/classes?institutionId=${institutionId}`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as ClassBody[];
  };

  const bulk = (classesBody: object[], token = owner.token, institutionId = first) =>
    api('post', '/v1/classes/bulk', token, { institutionId, classes: classesBody });

  const addSection = (classId: string, fields: object = {}, token = owner.token) =>
    api('post', '/v1/sections', token, {
      classId,
      predefinedSectionId: section('A').id,
      ...fields,
    });
  const sectionAdded = async (classId: string, fields: object = {}, token = owner.token) => {
    const res = await addSection(classId, fields, token);
    expect(res.status).toBe(201);
    return res.body.data as unknown as SectionBody;
  };
  const sections = async (classId: string, token = owner.token) => {
    const res = await api('get', `/v1/classes/${classId}/sections`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as SectionBody[];
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
    categories = await masters('class-categories');
    predefinedClasses = await masters('predefined-classes');
    predefinedSections = await masters('predefined-sections');
    societyA = await makeSociety();
    owner = await fixtures.owner(societyA);
    first = await makeInstitution(owner.token, [
      category('HIGH_SCHOOL').id,
      category('PRE_UNIVERSITY').id,
      category('SENIOR_SECONDARY').id,
    ]);
    second = await makeInstitution(owner.token);
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
    societyB = await makeSociety();
    otherOwner = await fixtures.owner(societyB);
    other = await makeInstitution(otherOwner.token, [category('HIGH_SCHOOL').id]);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    await removeScratchMasters(ownerDb, scratch.splice(0));
    await fixtures.cleanup();
  });

  describe('CLS-02 add a class', () => {
    it('names it after the predefined class, takes its category, and audits it', async () => {
      const created = await classAdded(first);
      expect(created).toMatchObject({
        institutionId: first,
        predefinedClass: { id: predefined('C09').id, code: 'C09', name: '9th' },
        category: { id: category('HIGH_SCHOOL').id, code: 'HIGH_SCHOOL' },
        streamName: null,
        displayName: '9th',
        code: null,
        sectionCount: 0,
        status: 1,
        version: 1,
      });

      const [row, ...rest] = await audit(created.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        action: 'class.created',
        entity_type: 'class',
        actor_user_id: owner.person,
        society_id: societyA,
        institution_id: first,
        old_values: null,
      });
      expect(row!.new_values).toMatchObject({ display_name: '9th', stream_name: null });
    });

    it('keeps the name and code the request gives, and lets an Institution Admin add to theirs', async () => {
      const created = await classAdded(
        first,
        { displayName: 'Ninth Standard', code: 'IX' },
        institutionAdmin.token,
      );
      expect(created).toMatchObject({ displayName: 'Ninth Standard', code: 'IX' });
    });

    it('gives a Pre-University class its stream, and the stream goes into the default name', async () => {
      const created = await classAdded(first, {
        predefinedClassId: predefined('PUC1').id,
        streamName: 'PCMC',
      });
      expect(created).toMatchObject({
        streamName: 'PCMC',
        displayName: 'PUC 1st Year PCMC',
        category: { code: 'PRE_UNIVERSITY' },
      });
      const noStream = await classAdded(first, { predefinedClassId: predefined('PUC2').id });
      expect(noStream).toMatchObject({ streamName: null, displayName: 'PUC 2nd Year' });
    });

    it('refuses a stream outside Pre-University with 422 STREAM_NOT_ALLOWED, naming the field', async () => {
      for (const code of ['C09', 'C11']) {
        const res = await addClass(first, {
          predefinedClassId: predefined(code).id,
          streamName: 'PCMC',
        });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({
          code: 'STREAM_NOT_ALLOWED',
          errors: [{ field: 'streamName', code: 'STREAM_NOT_ALLOWED' }],
        });
      }
      expect(await classes(first)).toEqual([]);
    });

    it('accepts a Senior Secondary class when the Institution offers it, with the stream as a section name', async () => {
      const created = await classAdded(first, { predefinedClassId: predefined('C11').id });
      expect(created.category.code).toBe('SENIOR_SECONDARY');
    });

    it('refuses a category the Institution does not offer with 422 CLASS_NOT_OFFERED', async () => {
      const notOffered = await addClass(second);
      expect(notOffered.status).toBe(422);
      expect(notOffered.body).toMatchObject({
        code: 'CLASS_NOT_OFFERED',
        errors: [{ field: 'predefinedClassId', code: 'CLASS_NOT_OFFERED' }],
      });
      const other10 = await addClass(first, { predefinedClassId: predefined('C03').id });
      expect(other10.status).toBe(422);
      expect(other10.body.code).toBe('CLASS_NOT_OFFERED');
    });

    it('refuses the same class twice with 409 DUPLICATE, and frees it when the first is deactivated', async () => {
      const one = await classAdded(first);
      const twice = await addClass(first);
      expect(twice.status).toBe(409);
      expect(twice.body).toMatchObject({
        code: 'DUPLICATE',
        errors: [{ field: 'predefinedClassId' }],
      });
      expect((await api('delete', `/v1/classes/${one.id}`, owner.token)).status).toBe(200);
      expect((await addClass(first)).status).toBe(201);
    });

    it('allows two streams of one Pre-University class, and refuses the same stream in any letter case', async () => {
      const body = { predefinedClassId: predefined('PUC1').id };
      await classAdded(first, { ...body, streamName: 'PCMC' });
      await classAdded(first, { ...body, streamName: 'HEBA' });
      const same = await addClass(first, { ...body, streamName: 'pcmc' });
      expect(same.status).toBe(409);
      expect(same.body.errors).toEqual([
        expect.objectContaining({ field: 'streamName', code: 'DUPLICATE' }),
      ]);
    });

    it('refuses a name another active class of the Institution has, ignoring letter case', async () => {
      await classAdded(first, { displayName: 'Ninth' });
      const res = await addClass(first, {
        predefinedClassId: predefined('C10').id,
        displayName: 'NINTH',
      });
      expect(res.status).toBe(409);
      expect(res.body.errors).toEqual([expect.objectContaining({ field: 'displayName' })]);
      // The same name in another Institution is fine.
      expect((await addClass(other, { displayName: 'Ninth' }, otherOwner.token)).status).toBe(201);
    });

    it('is 404 for a predefined class that does not exist and 422 REFERENCE_INACTIVE for a hidden one', async () => {
      expect((await addClass(first, { predefinedClassId: missing })).status).toBe(404);
      const entry = await api('post', '/v1/platform/masters/predefined-classes', admin, {
        classCategoryId: category('HIGH_SCHOOL').id,
        code: `X${newId().slice(-8).toUpperCase()}`.replace(/[^A-Z0-9]/g, 'X'),
        name: `Scratch ${newId().slice(-6)}`,
      });
      expect(entry.status).toBe(201);
      scratch.push({ table: 'predefined_classes', id: entry.body.data.id });
      expect((await addClass(first, { predefinedClassId: entry.body.data.id })).status).toBe(201);
      const hidden = await api('post', '/v1/platform/masters/predefined-classes', admin, {
        classCategoryId: category('HIGH_SCHOOL').id,
        code: `Y${newId().slice(-8).toUpperCase()}`.replace(/[^A-Z0-9]/g, 'Y'),
        name: `Scratch ${newId().slice(-6)}`,
      });
      scratch.push({ table: 'predefined_classes', id: hidden.body.data.id });
      expect(
        (
          await api(
            'delete',
            `/v1/platform/masters/predefined-classes/${hidden.body.data.id}`,
            admin,
          )
        ).status,
      ).toBe(200);
      const res = await addClass(first, { predefinedClassId: hidden.body.data.id });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: 'REFERENCE_INACTIVE',
        errors: [{ field: 'predefinedClassId' }],
      });
    });

    it('reads IDs in upper case as it reads them in lower case, in the body, the query and the path', async () => {
      const created = await classAdded(first, {
        institutionId: first.toUpperCase(),
        predefinedClassId: predefined('C09').id.toUpperCase(),
      });
      expect(created.predefinedClass.id).toBe(predefined('C09').id);
      const listed = await api(
        'get',
        `/v1/classes?institutionId=${first.toUpperCase()}`,
        owner.token,
      );
      expect(listed.status).toBe(200);
      const added = await sectionAdded(created.id, {
        classId: created.id.toUpperCase(),
        predefinedSectionId: section('A').id.toUpperCase(),
      });
      expect(added.classId).toBe(created.id);
      expect(
        (await api('get', `/v1/classes/${created.id.toUpperCase()}/sections`, owner.token)).status,
      ).toBe(200);
    });

    it('refuses what is not a field, a bad type and a missing Institution', async () => {
      for (const extra of [{ status: 0 }, { societyId: societyA }, { classCategoryId: 'x' }]) {
        expect((await addClass(first, extra)).status).toBe(400);
      }
      expect((await addClass(first, { predefinedClassId: 5 })).status).toBe(400);
      expect((await addClass(first, { displayName: 'x'.repeat(61) })).status).toBe(400);
      expect((await addClass(missing)).status).toBe(404);
    });

    it('is closed to Super Admin, to an Admin of another Institution and to another Society', async () => {
      expect((await addClass(first, {}, admin)).status).toBe(403);
      expect((await addClass(second, {}, institutionAdmin.token)).status).toBe(404);
      expect((await addClass(first, {}, otherOwner.token)).status).toBe(404);
      expect(await classes(first)).toEqual([]);
    });
  });

  describe('CLS-03 add classes in bulk', () => {
    it('adds them all in the order asked, each with its audit entry', async () => {
      const res = await bulk([
        { predefinedClassId: predefined('C10').id },
        { predefinedClassId: predefined('C09').id, displayName: 'Ninth' },
        { predefinedClassId: predefined('PUC1').id, streamName: 'PCMC' },
      ]);
      expect(res.status).toBe(201);
      const created = res.body.data as unknown as ClassBody[];
      expect(created.map((c) => c.displayName)).toEqual(['10th', 'Ninth', 'PUC 1st Year PCMC']);
      expect(await classes(first)).toHaveLength(3);
      for (const c of created) expect(await audit(c.id)).toHaveLength(1);
    });

    it('adds none when one is refused, and names the item', async () => {
      const res = await bulk([
        { predefinedClassId: predefined('C09').id },
        { predefinedClassId: predefined('C10').id, streamName: 'PCMC' },
      ]);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: 'STREAM_NOT_ALLOWED',
        errors: [{ field: 'classes[1].streamName' }],
      });
      expect(await classes(first)).toEqual([]);
      const notOffered = await bulk([
        { predefinedClassId: predefined('C09').id },
        { predefinedClassId: predefined('C03').id },
      ]);
      expect(notOffered.body.errors).toEqual([
        expect.objectContaining({ field: 'classes[1].predefinedClassId' }),
      ]);
      expect(await classes(first)).toEqual([]);
    });

    it('refuses the same class twice in one request, and one already there, adding none', async () => {
      const twice = await bulk([
        { predefinedClassId: predefined('C09').id },
        { predefinedClassId: predefined('C09').id },
      ]);
      expect(twice.status).toBe(409);
      expect(twice.body.errors).toEqual([
        expect.objectContaining({ field: 'classes[1].predefinedClassId', code: 'DUPLICATE' }),
      ]);
      await classAdded(first);
      const there = await bulk([
        { predefinedClassId: predefined('C10').id },
        { predefinedClassId: predefined('C09').id },
      ]);
      expect(there.status).toBe(409);
      expect(await classes(first)).toHaveLength(1);
    });

    it('takes one to fifty and refuses none or fifty-one', async () => {
      expect((await bulk([])).status).toBe(400);
      const many = await bulk(
        Array.from({ length: 51 }, () => ({ predefinedClassId: predefined('C09').id })),
      );
      expect(many.status).toBe(400);
      expect(many.body.errors).toEqual([
        expect.objectContaining({ field: 'classes', code: 'TOO_MANY' }),
      ]);
      const bad = await bulk([{ predefinedClassId: 'x' }]);
      expect(bad.body.errors).toEqual([
        expect.objectContaining({ field: 'classes[0].predefinedClassId' }),
      ]);
    });

    it('refuses an item that is not an object, such as a list, a string or null', async () => {
      const item = { predefinedClassId: predefined('C09').id };
      for (const wrong of [[], [item], 'C09', null]) {
        const res = await bulk([wrong] as object[]);
        expect(res.status).toBe(400);
        expect(res.body.errors).toContainEqual(
          expect.objectContaining({ field: 'classes', code: 'INVALID_TYPE' }),
        );
      }
    });

    it('is for an Owner or an Admin of the Institution only', async () => {
      const one = [{ predefinedClassId: predefined('C09').id }];
      expect((await bulk(one, admin)).status).toBe(403);
      expect((await bulk(one, institutionAdmin.token, second)).status).toBe(404);
      expect((await bulk(one, otherOwner.token)).status).toBe(404);
      expect((await bulk(one, institutionAdmin.token)).status).toBe(201);
    });
  });

  describe('CLS-01 list the classes', () => {
    it('lists the active ones by category, predefined class and stream, with their section counts', async () => {
      const ten = await classAdded(first, { predefinedClassId: predefined('C10').id });
      const nine = await classAdded(first);
      const pu2 = await classAdded(first, {
        predefinedClassId: predefined('PUC2').id,
        streamName: 'PCMC',
      });
      const pu1b = await classAdded(first, {
        predefinedClassId: predefined('PUC1').id,
        streamName: 'PCMC',
      });
      const pu1a = await classAdded(first, {
        predefinedClassId: predefined('PUC1').id,
        streamName: 'HEBA',
      });
      await sectionAdded(nine.id);
      const gone = await sectionAdded(nine.id, { predefinedSectionId: section('B').id });
      await sectionAdded(nine.id, { predefinedSectionId: section('C').id });
      expect((await api('delete', `/v1/sections/${gone.id}`, owner.token)).status).toBe(200);

      const list = await classes(first);
      expect(list.map((c) => c.id)).toEqual([nine.id, ten.id, pu1a.id, pu1b.id, pu2.id]);
      expect(list.map((c) => c.sectionCount)).toEqual([2, 0, 0, 0, 0]);
    });

    it('leaves out a deactivated class and shows none of another Institution’s', async () => {
      const gone = await classAdded(first);
      await classAdded(other, {}, otherOwner.token);
      expect((await api('delete', `/v1/classes/${gone.id}`, owner.token)).status).toBe(200);
      expect(await classes(first)).toEqual([]);
    });

    it('is open to an Owner and the Admin of the Institution, and 404 elsewhere; Super Admin is not a caller', async () => {
      await classAdded(first);
      expect(await classes(first, institutionAdmin.token)).toHaveLength(1);
      expect(
        (await api('get', `/v1/classes?institutionId=${second}`, institutionAdmin.token)).status,
      ).toBe(404);
      expect(
        (await api('get', `/v1/classes?institutionId=${first}`, otherOwner.token)).status,
      ).toBe(404);
      expect((await api('get', `/v1/classes?institutionId=${first}`, admin)).status).toBe(403);
      expect((await api('get', '/v1/classes', owner.token)).status).toBe(400);
    });
  });

  describe('CLS-04 edit a class', () => {
    it('changes the name and the code, bumps the version and audits before and after', async () => {
      const created = await classAdded(first, { code: 'IX' });
      const res = await api('patch', `/v1/classes/${created.id}`, owner.token, {
        version: 1,
        displayName: 'Ninth',
        code: null,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        displayName: 'Ninth',
        code: null,
        version: 2,
        sectionCount: 0,
      });
      const rows = await audit(created.id);
      expect(rows.map((r) => r.action)).toEqual(['class.created', 'class.updated']);
      expect(rows[1]).toMatchObject({
        old_values: expect.objectContaining({ display_name: '9th', code: 'IX' }),
        new_values: expect.objectContaining({ display_name: 'Ninth', code: null }),
      });
    });

    it('checks the version first, and writes nothing for a request that changes nothing', async () => {
      const created = await classAdded(first);
      const stale = await api('patch', `/v1/classes/${created.id}`, owner.token, {
        version: 5,
        displayName: 'x',
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      const same = await api('patch', `/v1/classes/${created.id}`, owner.token, {
        version: 1,
        displayName: '9th',
      });
      expect(same.status).toBe(200);
      expect(same.body.data.version).toBe(1);
      expect(await audit(created.id)).toHaveLength(1);
    });

    it('refuses the fields that never change, a null name, and a name another class has', async () => {
      const created = await classAdded(first);
      await classAdded(first, { predefinedClassId: predefined('C10').id });
      for (const extra of [
        { streamName: 'PCMC' },
        { predefinedClassId: predefined('C10').id },
        { institutionId: second },
        { status: 0 },
        { displayName: null },
      ]) {
        const res = await api('patch', `/v1/classes/${created.id}`, owner.token, {
          version: 1,
          ...extra,
        });
        expect(res.status).toBe(400);
      }
      const taken = await api('patch', `/v1/classes/${created.id}`, owner.token, {
        version: 1,
        displayName: '10TH',
      });
      expect(taken.status).toBe(409);
      expect(taken.body.errors).toEqual([expect.objectContaining({ field: 'displayName' })]);
    });

    it('is 404 for a deactivated class, another Institution’s, and another Society’s', async () => {
      const created = await classAdded(first);
      const body = { version: 1, displayName: 'x' };
      expect((await api('patch', `/v1/classes/${created.id}`, otherOwner.token, body)).status).toBe(
        404,
      );
      expect((await api('patch', `/v1/classes/${missing}`, owner.token, body)).status).toBe(404);
      expect((await api('patch', `/v1/classes/${created.id}`, admin, body)).status).toBe(403);
      const inSecond = await fixtures.institutionAdmin(societyA, [second]);
      expect((await api('patch', `/v1/classes/${created.id}`, inSecond.token, body)).status).toBe(
        404,
      );
      expect((await api('delete', `/v1/classes/${created.id}`, owner.token)).status).toBe(200);
      expect((await api('patch', `/v1/classes/${created.id}`, owner.token, body)).status).toBe(404);
    });
  });

  describe('CLS-05 deactivate a class', () => {
    it('deactivates the class and its sections together, frees the name and audits both', async () => {
      const created = await classAdded(first);
      const a = await sectionAdded(created.id);
      const b = await sectionAdded(created.id, { predefinedSectionId: section('B').id });
      const res = await api('delete', `/v1/classes/${created.id}`, owner.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: created.id, status: 0 });

      expect(await classes(first)).toEqual([]);
      expect((await api('get', `/v1/classes/${created.id}/sections`, owner.token)).status).toBe(
        404,
      );
      for (const gone of [a, b]) {
        expect((await audit(gone.id)).map((r) => r.action)).toEqual([
          'section.created',
          'section.deactivated',
        ]);
      }
      expect((await audit(created.id)).map((r) => r.action)).toEqual([
        'class.created',
        'class.deactivated',
      ]);
      expect((await addClass(first)).status).toBe(201);
    });

    it('is 404 the second time, and for a section of the class afterwards', async () => {
      const created = await classAdded(first);
      const a = await sectionAdded(created.id);
      expect((await api('delete', `/v1/classes/${created.id}`, owner.token)).status).toBe(200);
      expect((await api('delete', `/v1/classes/${created.id}`, owner.token)).status).toBe(404);
      expect((await api('delete', `/v1/sections/${a.id}`, owner.token)).status).toBe(404);
    });

    it('is closed to Super Admin and to another Society', async () => {
      const created = await classAdded(first);
      expect((await api('delete', `/v1/classes/${created.id}`, admin)).status).toBe(403);
      expect((await api('delete', `/v1/classes/${created.id}`, otherOwner.token)).status).toBe(404);
      expect(await classes(first)).toHaveLength(1);
    });
  });

  describe('SEC-02 add a section', () => {
    it('names it after the predefined section, with no capacity, and audits it', async () => {
      const created = await classAdded(first);
      const added = await sectionAdded(created.id);
      expect(added).toMatchObject({
        classId: created.id,
        predefinedSection: { code: 'A' },
        displayName: 'A',
        capacity: null,
        currentStudentCount: null,
        classTeacher: null,
        status: 1,
        version: 1,
      });
      const [row] = await audit(added.id);
      expect(row).toMatchObject({
        action: 'section.created',
        entity_type: 'section',
        actor_user_id: owner.person,
        society_id: societyA,
        institution_id: first,
      });
      expect((await classes(first))[0]!.sectionCount).toBe(1);
    });

    it('keeps the name and capacity the request gives', async () => {
      const created = await classAdded(first);
      const added = await sectionAdded(
        created.id,
        { displayName: 'Rose', capacity: 35 },
        institutionAdmin.token,
      );
      expect(added).toMatchObject({ displayName: 'Rose', capacity: 35 });
    });

    it('refuses the same predefined section twice in a class and a name already used, ignoring case', async () => {
      const created = await classAdded(first);
      const other9 = await classAdded(first, { predefinedClassId: predefined('C10').id });
      await sectionAdded(created.id);
      const twice = await addSection(created.id);
      expect(twice.status).toBe(409);
      expect(twice.body.errors).toEqual([
        expect.objectContaining({ field: 'predefinedSectionId' }),
      ]);
      const named = await addSection(created.id, {
        predefinedSectionId: section('B').id,
        displayName: 'a',
      });
      expect(named.status).toBe(409);
      expect(named.body.errors).toEqual([expect.objectContaining({ field: 'displayName' })]);
      // Another class may use both.
      expect((await addSection(other9.id)).status).toBe(201);
    });

    it('accepts a capacity from 1 to 32767 and refuses the rest, and does not stop a class from holding more sections than it has room for', async () => {
      const created = await classAdded(first);
      expect((await sectionAdded(created.id, { capacity: 1 })).capacity).toBe(1);
      for (const [i, capacity] of [0, -1, 32_768, 1.5, '30', true].entries()) {
        const res = await addSection(created.id, {
          predefinedSectionId: section(['B', 'C', 'D', 'E', 'F', 'G'][i]!).id,
          capacity,
        });
        expect(res.status).toBe(400);
        expect(res.body.errors).toEqual([expect.objectContaining({ field: 'capacity' })]);
      }
      expect(
        (await addSection(created.id, { predefinedSectionId: section('H').id, capacity: 32_767 }))
          .status,
      ).toBe(201);
    });

    it('is 404 for a class that does not exist, is deactivated, or is not the caller’s; 404 for a master that does not exist', async () => {
      const created = await classAdded(first);
      expect((await addSection(missing)).status).toBe(404);
      expect((await addSection(created.id, {}, otherOwner.token)).status).toBe(404);
      expect((await addSection(created.id, {}, admin)).status).toBe(403);
      expect((await addSection(created.id, { predefinedSectionId: missing })).status).toBe(404);
      expect((await api('delete', `/v1/classes/${created.id}`, owner.token)).status).toBe(200);
      expect((await addSection(created.id)).status).toBe(404);
    });

    it('refuses what is not a field', async () => {
      const created = await classAdded(first);
      for (const extra of [{ status: 0 }, { institutionId: first }, { classTeacher: 'x' }]) {
        expect((await addSection(created.id, extra)).status).toBe(400);
      }
    });
  });

  describe('SEC-01 list the sections', () => {
    it('lists the active ones in the order of the predefined sections', async () => {
      const created = await classAdded(first);
      const c = await sectionAdded(created.id, { predefinedSectionId: section('C').id });
      const a = await sectionAdded(created.id);
      const b = await sectionAdded(created.id, { predefinedSectionId: section('B').id });
      expect((await api('delete', `/v1/sections/${b.id}`, owner.token)).status).toBe(200);
      expect((await sections(created.id)).map((s) => s.id)).toEqual([a.id, c.id]);
      expect(await sections(created.id, institutionAdmin.token)).toHaveLength(2);
    });

    it('is 404 for a class outside the caller’s scope, and not for Super Admin', async () => {
      const inSecond = await classAdded(first);
      const lone = await fixtures.institutionAdmin(societyA, [second]);
      expect((await api('get', `/v1/classes/${inSecond.id}/sections`, lone.token)).status).toBe(
        404,
      );
      expect(
        (await api('get', `/v1/classes/${inSecond.id}/sections`, otherOwner.token)).status,
      ).toBe(404);
      expect((await api('get', `/v1/classes/${inSecond.id}/sections`, admin)).status).toBe(403);
      expect((await api('get', `/v1/classes/${missing}/sections`, owner.token)).status).toBe(404);
    });
  });

  describe('SEC-03 and SEC-04 edit and deactivate a section', () => {
    it('changes the name and capacity, clears the capacity with null, and audits it', async () => {
      const created = await classAdded(first);
      const added = await sectionAdded(created.id, { capacity: 40 });
      const res = await api('patch', `/v1/sections/${added.id}`, owner.token, {
        version: 1,
        displayName: 'Rose',
        capacity: null,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ displayName: 'Rose', capacity: null, version: 2 });
      const rows = await audit(added.id);
      expect(rows[1]).toMatchObject({
        action: 'section.updated',
        old_values: expect.objectContaining({ display_name: 'A', capacity: 40 }),
        new_values: expect.objectContaining({ display_name: 'Rose', capacity: null }),
      });
    });

    it('checks the version first, writes nothing when nothing changes, and refuses fields that never change', async () => {
      const created = await classAdded(first);
      const added = await sectionAdded(created.id, { capacity: 40 });
      expect(
        (await api('patch', `/v1/sections/${added.id}`, owner.token, { version: 9, capacity: 1 }))
          .body.code,
      ).toBe('VERSION_CONFLICT');
      const same = await api('patch', `/v1/sections/${added.id}`, owner.token, {
        version: 1,
        capacity: 40,
      });
      expect(same.body.data.version).toBe(1);
      expect(await audit(added.id)).toHaveLength(1);
      for (const extra of [
        { classId: created.id },
        { predefinedSectionId: section('B').id },
        { status: 0 },
      ]) {
        expect(
          (await api('patch', `/v1/sections/${added.id}`, owner.token, { version: 1, ...extra }))
            .status,
        ).toBe(400);
      }
    });

    it('refuses a name another section of the class has', async () => {
      const created = await classAdded(first);
      await sectionAdded(created.id);
      const b = await sectionAdded(created.id, { predefinedSectionId: section('B').id });
      const res = await api('patch', `/v1/sections/${b.id}`, owner.token, {
        version: 1,
        displayName: 'a',
      });
      expect(res.status).toBe(409);
      expect(res.body.errors).toEqual([expect.objectContaining({ field: 'displayName' })]);
    });

    it('deactivates, frees the predefined section for the class again, and then is 404', async () => {
      const created = await classAdded(first);
      const added = await sectionAdded(created.id);
      const res = await api('delete', `/v1/sections/${added.id}`, institutionAdmin.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: added.id, status: 0 });
      expect((await audit(added.id)).map((r) => r.action)).toEqual([
        'section.created',
        'section.deactivated',
      ]);
      expect((await api('delete', `/v1/sections/${added.id}`, owner.token)).status).toBe(404);
      expect(
        (await api('patch', `/v1/sections/${added.id}`, owner.token, { version: 2, capacity: 3 }))
          .status,
      ).toBe(404);
      expect((await addSection(created.id)).status).toBe(201);
    });

    it('is closed to Super Admin, other Societies and Admins of other Institutions', async () => {
      const created = await classAdded(first);
      const added = await sectionAdded(created.id);
      const lone = await fixtures.institutionAdmin(societyA, [second]);
      for (const token of [otherOwner.token, lone.token]) {
        expect((await api('delete', `/v1/sections/${added.id}`, token)).status).toBe(404);
        expect(
          (await api('patch', `/v1/sections/${added.id}`, token, { version: 1, capacity: 2 }))
            .status,
        ).toBe(404);
      }
      expect((await api('delete', `/v1/sections/${added.id}`, admin)).status).toBe(403);
      expect(await sections(created.id)).toHaveLength(1);
    });
  });

  describe('the classes an Institution offers (INS-04) while it has classes', () => {
    it('refuses to untick a category a class is in with 409 CATEGORY_IN_USE, and changes nothing', async () => {
      await classAdded(first);
      const before = (await api('get', `/v1/institutions/${first}`, owner.token)).body.data;
      const res = await api('patch', `/v1/institutions/${first}`, owner.token, {
        version: before.version,
        classesOffered: [category('PRE_UNIVERSITY').id, category('SENIOR_SECONDARY').id],
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'CATEGORY_IN_USE',
        errors: [{ field: 'classesOffered', code: 'CATEGORY_IN_USE' }],
      });
      const after = (await api('get', `/v1/institutions/${first}`, owner.token)).body.data;
      expect(after.version).toBe(before.version);
      expect(after.classesOffered).toHaveLength(3);
    });

    it('still refuses when the only class of the category is deactivated (the key remembers it)', async () => {
      const created = await classAdded(first);
      expect((await api('delete', `/v1/classes/${created.id}`, owner.token)).status).toBe(200);
      const res = await api('patch', `/v1/institutions/${first}`, owner.token, {
        version: 1,
        classesOffered: [category('PRE_UNIVERSITY').id, category('SENIOR_SECONDARY').id],
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CATEGORY_IN_USE');
    });

    it('lets an unused category go and a new one be added', async () => {
      await classAdded(first);
      const res = await api('patch', `/v1/institutions/${first}`, owner.token, {
        version: 1,
        classesOffered: [category('HIGH_SCHOOL').id, category('LOWER_PRIMARY').id],
      });
      expect(res.status).toBe(200);
      expect((res.body.data.classesOffered as Entry[]).map((c) => c.code)).toEqual([
        'LOWER_PRIMARY',
        'HIGH_SCHOOL',
      ]);
    });
  });

  describe('the database itself', () => {
    it('keeps one Society’s classes and sections from another’s, and from a caller with no scope', async () => {
      const created = await classAdded(first);
      const added = await sectionAdded(created.id);
      const seenByOther = tenantOf(otherOwner, societyB, [other]);
      expect(
        await database.transaction(seenByOther, (tx) =>
          tx.selectFrom('classes').select('id').execute(),
        ),
      ).toEqual([]);
      expect(
        await database.transaction(seenByOther, (tx) =>
          tx.selectFrom('sections').select('id').execute(),
        ),
      ).toEqual([]);
      const nobody = { personId: owner.person, roleCode: 2 };
      expect(
        await database.transaction(nobody, (tx) => tx.selectFrom('classes').select('id').execute()),
      ).toEqual([]);
      const seenByAdmin = {
        personId: institutionAdmin.person,
        roleCode: 3,
        societyId: societyA,
        institutionIds: [first],
      };
      expect(
        await database.transaction(seenByAdmin, (tx) =>
          tx.selectFrom('classes').select('id').execute(),
        ),
      ).toEqual([{ id: created.id }]);
      expect(
        await database.transaction(seenByAdmin, (tx) =>
          tx.selectFrom('sections').select('id').execute(),
        ),
      ).toEqual([{ id: added.id }]);
    });

    it('refuses to move a class or a section to an Institution outside the scope', async () => {
      const created = await classAdded(first);
      const added = await sectionAdded(created.id);
      const scope = tenantOf(owner, societyA, [first]);
      await expect(
        database.transaction(scope, (tx) =>
          tx
            .updateTable('classes')
            .set({ institution_id: second })
            .where('id', '=', created.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        database.transaction(scope, (tx) =>
          tx
            .updateTable('sections')
            .set({ institution_id: second })
            .where('id', '=', added.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses a class in a category the Institution does not offer, even past the application', async () => {
      await expect(
        database.transaction(tenantOf(owner, societyA, [second]), (tx) =>
          tx
            .insertInto('classes')
            .values({
              society_id: societyA,
              institution_id: second,
              predefined_class_id: predefined('C09').id,
              class_category_id: category('HIGH_SCHOOL').id,
              display_name: '9th',
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'fk_classes_offered_category' });
    });

    it('refuses a class whose category is not its predefined class’s, and a section capacity of zero', async () => {
      await expect(
        database.transaction(tenantOf(owner, societyA, [first]), (tx) =>
          tx
            .insertInto('classes')
            .values({
              society_id: societyA,
              institution_id: first,
              predefined_class_id: predefined('C09').id,
              class_category_id: category('PRE_UNIVERSITY').id,
              display_name: '9th',
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'fk_classes_predefined' });
      const created = await classAdded(first);
      await expect(
        database.transaction(tenantOf(owner, societyA, [first]), (tx) =>
          tx
            .insertInto('sections')
            .values({
              society_id: societyA,
              institution_id: first,
              class_id: created.id,
              predefined_section_id: section('A').id,
              display_name: 'A',
              capacity: 0,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it.each(['classes', 'sections'] as const)(
      'lets an update of every %s row that reads no column touch only the caller’s Society',
      async (table) => {
        // With no WHERE the statement reads no column, so the SELECT policy never checks a row: only the update
        // policy keeps it to the caller's Society.
        const mineClass = await classAdded(first);
        const theirClass = await classAdded(other, {}, otherOwner.token);
        const mine = table === 'classes' ? mineClass : await sectionAdded(mineClass.id);
        const theirs =
          table === 'classes'
            ? theirClass
            : await sectionAdded(theirClass.id, {}, otherOwner.token);
        const touched = await database.transaction(tenantOf(owner, societyA, [first]), (tx) =>
          tx.updateTable(table).set({ updated_at: new Date() }).executeTakeFirst(),
        );
        expect(Number(touched.numUpdatedRows)).toBe(1);
        const versionOf = (society: string, institution: string, id: string) =>
          ownerDb.transaction().execute(async (tx) => {
            await sql`select set_config('app.society_id', ${society}, true),
              set_config('app.institution_ids', ${institution}, true)`.execute(tx);
            const rows = await sql<{ version: number }>`
              select version from ${sql.table(table)} where id = ${id}`.execute(tx);
            return rows.rows[0]?.version;
          });
        expect(await versionOf(societyA, first, mine.id)).toBe(2);
        expect(await versionOf(societyB, other, theirs.id)).toBe(1);
      },
    );

    it('gives the application no right to delete a class or a section', async () => {
      const created = await classAdded(first);
      const added = await sectionAdded(created.id);
      const scope = tenantOf(owner, societyA, [first]);
      await expect(
        database.transaction(scope, (tx) =>
          tx.deleteFrom('sections').where('id', '=', added.id).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        database.transaction(scope, (tx) =>
          tx.deleteFrom('classes').where('id', '=', created.id).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('two requests at once', () => {
    it('add one class once, and one section once', async () => {
      const results = await Promise.all(Array.from({ length: 4 }, () => addClass(first)));
      expect(results.map((r) => r.status).toSorted()).toEqual([201, 409, 409, 409]);
      const created = (await classes(first))[0]!;
      const sectionResults = await Promise.all(
        Array.from({ length: 4 }, () => addSection(created.id)),
      );
      expect(sectionResults.map((r) => r.status).toSorted()).toEqual([201, 409, 409, 409]);
    });

    it('a section added while its class is deactivated never survives it', async () => {
      const created = await classAdded(first);
      const results = await Promise.all([
        api('delete', `/v1/classes/${created.id}`, owner.token),
        addSection(created.id),
        addSection(created.id, { predefinedSectionId: section('B').id }),
      ]);
      for (const res of results) expect(res.status).toBeLessThan(500);
      const rows = await ownerDb.transaction().execute(async (tx) => {
        await sql`alter table sections no force row level security`.execute(tx);
        return sql<{ n: number }>`
          select count(*)::int n from sections where class_id = ${created.id} and status = 1
        `.execute(tx);
      });
      expect(rows.rows[0]!.n).toBe(0);
    });
  });
});
