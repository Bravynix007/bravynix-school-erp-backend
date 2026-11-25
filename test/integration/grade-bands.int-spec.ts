import { sql, Kysely, PostgresDialect } from 'kysely';
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
import { SchoolKit, succeeded } from '../support/school-kit.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '0192f3b0-0000-7000-8000-00000000ffff';

interface Band {
  id: string;
  institutionId: string;
  name: string;
  minPercentage: number;
  maxPercentage: number;
  gradePoint: number | null;
  description: string | null;
  status: number;
  version: number;
}

const fieldsOf = (res: { body: { errors?: { field: string; code: string }[] } }) =>
  Object.fromEntries((res.body.errors ?? []).map((e) => [e.field, e.code]));

const parentEmail = `${Math.random().toString(36).slice(2)}@parent.test`;
const guardian = {
  firstName: 'Ravi',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  email: parentEmail,
  isPrimary: true,
  isEmergencyContact: true,
};

describe('GRD-01 to GRD-04 grade bands (API design 9.4)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;

  /** Society A: two Institutions, the first with a teacher, an Admin and a child. */
  let societyA: string;
  let first: string;
  let second: string;
  let owner: SignedInPerson;
  let firstAdmin: SignedInPerson;
  let secondAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let teacherToken: string;
  let parentToken: string;
  let strangerToken: string;
  let childId: string;
  let categoryId: string;

  const body = (fields: object = {}) => ({
    institutionId: first,
    name: 'A1',
    minPercentage: 91,
    maxPercentage: 100,
    gradePoint: 10,
    description: 'Outstanding',
    ...fields,
  });
  const add = (fields: object = {}, token = owner.token) =>
    api('post', '/v1/grade-bands', token, body(fields));
  const added = async (fields: object = {}, token = owner.token) => {
    const res = succeeded(await add(fields, token), 201, 'grade band');
    return res.body.data as unknown as Band;
  };
  const read = (query: string, token = owner.token) =>
    api('get', `/v1/grade-bands?${query}`, token);
  const bands = async (query = `institutionId=${first}`, token = owner.token) => {
    const res = await read(query, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Band[];
  };
  /** The bands a request sees as a parent with these children in it (row-level security). */
  const rowsSeenAsParent = (childIds: string[]) =>
    database.transaction({ personId: owner.person, roleCode: 5, childIds }, (tx) =>
      tx.selectFrom('grade_bands').select(['id', 'institution_id']).execute(),
    );
  const edit = (id: string, fields: object, token = owner.token) =>
    api('patch', `/v1/grade-bands/${id}`, token, fields);
  const remove = (id: string, token = owner.token) => api('delete', `/v1/grade-bands/${id}`, token);
  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      institution_id: string | null;
      society_id: string | null;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);
  const asOwner = () => ({
    societyId: societyA,
    institutionIds: [first],
    roleCode: 2,
    personId: owner.person,
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
    kit = new SchoolKit(t, api);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    const predefined = (await kit.masters(admin, 'predefined-classes')).find(
      (c) => c.code === 'C10',
    )!.id;
    const sectionA = (await kit.masters(admin, 'predefined-sections')).find(
      (c) => c.code === 'A',
    )!.id;
    societyA = await kit.society(admin);
    owner = await fixtures.owner(societyA);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    const year = await kit.year(owner.token, first);
    firstAdmin = await fixtures.institutionAdmin(societyA, [first]);
    secondAdmin = await fixtures.institutionAdmin(societyA, [second]);
    otherOwner = await fixtures.owner(await kit.society(admin));
    const teacher = await kit.staff(owner.token, first, categoryId);
    teacherToken = await kit.actingAs(teacher.person.email, 4, societyA);
    const classId = await kit.klass(owner.token, first, predefined);
    const sectionId = await kit.section(owner.token, classId, sectionA);
    childId = (
      await kit.student(
        owner.token,
        first,
        { academicYearId: year, classId, sectionId },
        { guardians: [guardian] },
      )
    ).id;
    parentToken = (await signInMobile(t, parentEmail)).accessToken;
    // A child of another Society, whose parent is a stranger to this one.
    const strangerEmail = `${Math.random().toString(36).slice(2)}@parent.test`;
    const strangerInstitution = await kit.institution(otherOwner.token, categoryId);
    const strangerYear = await kit.year(otherOwner.token, strangerInstitution);
    const strangerClass = await kit.klass(otherOwner.token, strangerInstitution, predefined);
    const strangerSection = await kit.section(otherOwner.token, strangerClass, sectionA);
    await kit.student(
      otherOwner.token,
      strangerInstitution,
      { academicYearId: strangerYear, classId: strangerClass, sectionId: strangerSection },
      { guardians: [{ ...guardian, email: strangerEmail }] },
    );
    strangerToken = (await signInMobile(t, strangerEmail)).accessToken;
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('GRD-02 add', () => {
    it('lets the Owner and the Admin add a band, with its percentages as numbers', async () => {
      expect(await added()).toMatchObject({
        institutionId: first,
        name: 'A1',
        minPercentage: 91,
        maxPercentage: 100,
        gradePoint: 10,
        description: 'Outstanding',
        status: 1,
        version: 1,
      });
      expect(
        await added(
          { name: 'A2', minPercentage: 81, maxPercentage: 90.99, gradePoint: 8.5 },
          firstAdmin.token,
        ),
      ).toMatchObject({ minPercentage: 81, maxPercentage: 90.99, gradePoint: 8.5 });
    });

    it('keeps the grade point and the description optional, and takes a band of one value', async () => {
      expect(
        await added({ gradePoint: undefined, description: undefined, minPercentage: 100 }),
      ).toMatchObject({ gradePoint: null, description: null, minPercentage: 100 });
      expect(
        await added({ name: 'E', minPercentage: 0, maxPercentage: 0, gradePoint: null }),
      ).toMatchObject({ gradePoint: null, minPercentage: 0, maxPercentage: 0 });
    });

    it('refuses a teacher and a parent (403), an Admin of another Institution and another Society (404)', async () => {
      expect((await add({}, teacherToken)).status).toBe(403);
      expect((await add({}, parentToken)).status).toBe(403);
      expect((await add({}, secondAdmin.token)).status).toBe(404);
      expect((await add({}, otherOwner.token)).status).toBe(404);
      expect((await add({ institutionId: missing })).status).toBe(404);
      expect(await bands()).toEqual([]);
    });

    it('refuses what is not a band (400)', async () => {
      const cases: [object, Record<string, string>][] = [
        [{ name: '' }, { name: 'REQUIRED' }],
        [{ name: '   ' }, { name: 'REQUIRED' }],
        [{ name: 'x'.repeat(21) }, { name: 'TOO_LONG' }],
        [{ minPercentage: -1 }, { minPercentage: 'OUT_OF_RANGE' }],
        [{ maxPercentage: 100.01 }, { maxPercentage: 'OUT_OF_RANGE' }],
        [{ minPercentage: '91' }, { minPercentage: 'INVALID_TYPE' }],
        [{ minPercentage: 90.555 }, { minPercentage: 'INVALID_TYPE' }],
        [{ minPercentage: 95, maxPercentage: 94.99 }, { maxPercentage: 'OUT_OF_RANGE' }],
        [{ gradePoint: 10.5 }, { gradePoint: 'OUT_OF_RANGE' }],
        [{ gradePoint: '10' }, { gradePoint: 'INVALID_TYPE' }],
        [{ description: '  ' }, { description: 'TOO_SHORT' }],
        [{ description: 'x'.repeat(101) }, { description: 'TOO_LONG' }],
        [{ institutionId: 'nope' }, { institutionId: 'INVALID_FORMAT' }],
        [{ academicYearId: missing }, { academicYearId: 'FIELD_NOT_ALLOWED' }],
      ];
      for (const [fields, errors] of cases) {
        const res = await add(fields);
        expect([JSON.stringify(fields), res.status]).toEqual([JSON.stringify(fields), 400]);
        expect(fieldsOf(res)).toEqual(errors);
      }
      expect(await bands()).toEqual([]);
    });

    it('refuses a name in use in any letter case (409 DUPLICATE), and a range that shares a value (409 GRADE_BAND_OVERLAP)', async () => {
      await added({ name: 'B1', minPercentage: 71, maxPercentage: 80.99 });
      const again = await add({ name: 'b1' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('DUPLICATE');
      expect(fieldsOf(again)).toEqual({ name: 'DUPLICATE' });
      for (const [min, max] of [
        [71, 80.99],
        [80.99, 90],
        [60, 71],
        [75, 76],
        [0, 100],
      ] as const) {
        const res = await add({ name: 'X', minPercentage: min, maxPercentage: max });
        expect([`${min} to ${max}`, res.status]).toEqual([`${min} to ${max}`, 409]);
        expect(res.body.code).toBe('GRADE_BAND_OVERLAP');
        expect(fieldsOf(res)).toEqual({ minPercentage: 'GRADE_BAND_OVERLAP' });
      }
      expect(await bands()).toHaveLength(1);
    });

    it('lets bands sit side by side, one hundredth apart', async () => {
      await added({ name: 'B1', minPercentage: 71, maxPercentage: 80.99 });
      await added({ name: 'A2', minPercentage: 81, maxPercentage: 90.99 });
      await added({ name: 'B2', minPercentage: 61, maxPercentage: 70.99 });
      expect((await bands()).map((b) => b.name)).toEqual(['A2', 'B1', 'B2']);
    });

    it('lets only one of two overlapping bands saved at once in', async () => {
      const answers = await Promise.all([
        add({ name: 'A1', minPercentage: 90, maxPercentage: 100 }),
        add({ name: 'A2', minPercentage: 80, maxPercentage: 90 }),
      ]);
      expect(answers.map((a) => a.status).toSorted()).toEqual([201, 409]);
      expect(await bands()).toHaveLength(1);
    });

    it('keeps the bands of each Institution apart: the same name and range in another is fine', async () => {
      await added();
      await added({ institutionId: second });
      expect(await bands()).toHaveLength(1);
      expect(await bands(`institutionId=${second}`, secondAdmin.token)).toHaveLength(1);
    });

    it('writes one audit entry that names the Institution and the Society', async () => {
      const made = await added({ maxPercentage: 99.5 });
      const rows = await audit(made.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'grade_band.created',
        institution_id: first,
        society_id: societyA,
        new_values: {
          name: 'A1',
          min_percentage: 91,
          max_percentage: 99.5,
          grade_point: 10,
          description: 'Outstanding',
          status: 1,
        },
      });
    });

    it('writes no audit entry when the band is refused', async () => {
      await added();
      const before = await readAuditRows(ownerDb, sql`action = 'grade_band.created'`);
      expect((await add({ name: 'X', minPercentage: 95 })).status).toBe(409);
      expect((await add({ name: 'A1', minPercentage: 10, maxPercentage: 20 })).status).toBe(409);
      expect(await readAuditRows(ownerDb, sql`action = 'grade_band.created'`)).toHaveLength(
        before.length,
      );
    });
  });

  describe('GRD-01 read', () => {
    it('shows the active bands, the highest first, to the Owner, the Admin and a teacher of the Institution', async () => {
      await added({ name: 'C1', minPercentage: 51, maxPercentage: 60.99 });
      await added();
      const gone = await added({ name: 'D', minPercentage: 33, maxPercentage: 40.99 });
      succeeded(await remove(gone.id), 200, 'deactivated band');
      for (const token of [owner.token, firstAdmin.token, teacherToken]) {
        expect((await bands(`institutionId=${first}`, token)).map((b) => b.name)).toEqual([
          'A1',
          'C1',
        ]);
      }
    });

    it('is 404 for an Institution the caller does not reach, 400 without one, and 400 for a child named by someone who is not a parent', async () => {
      expect((await read(`institutionId=${first}`, secondAdmin.token)).status).toBe(404);
      expect((await read(`institutionId=${first}`, otherOwner.token)).status).toBe(404);
      const without = await read('');
      expect(without.status).toBe(400);
      expect(fieldsOf(without)).toEqual({ institutionId: 'REQUIRED' });
      const child = await read(`institutionId=${first}&studentId=${childId}`);
      expect(child.status).toBe(400);
      expect(fieldsOf(child)).toEqual({ studentId: 'FIELD_NOT_ALLOWED' });
    });

    it('lets a parent read their child’s Institution, and nothing else', async () => {
      await added();
      await added({ institutionId: second, name: 'Other' });
      const seen = await bands(`studentId=${childId}`, parentToken);
      expect(seen.map((b) => [b.institutionId, b.name])).toEqual([[first, 'A1']]);
      expect((await read(`studentId=${childId}`, strangerToken)).status).toBe(404);
      const none = await read('', parentToken);
      expect(none.status).toBe(400);
      expect(fieldsOf(none)).toEqual({ studentId: 'REQUIRED' });
      const named = await read(`studentId=${childId}&institutionId=${first}`, parentToken);
      expect(named.status).toBe(400);
      expect(fieldsOf(named)).toEqual({ institutionId: 'FIELD_NOT_ALLOWED' });
    });
  });

  describe('GRD-03 edit', () => {
    it('changes the name, the range, the grade point and the description, versioned, and audits before and after', async () => {
      const made = await added();
      const res = await edit(made.id, {
        version: 1,
        name: 'O',
        minPercentage: 90.5,
        gradePoint: 9.5,
        description: 'Top',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        name: 'O',
        minPercentage: 90.5,
        maxPercentage: 100,
        gradePoint: 9.5,
        description: 'Top',
        version: 2,
      });
      const rows = await audit(made.id);
      expect(rows.map((r) => r.action)).toEqual(['grade_band.created', 'grade_band.updated']);
      expect(rows[1]).toMatchObject({
        old_values: { name: 'A1', min_percentage: 91, grade_point: 10 },
        new_values: { name: 'O', min_percentage: 90.5, grade_point: 9.5 },
      });
    });

    it('clears the grade point and the description with null, and writes nothing for a request that changes nothing', async () => {
      const made = await added();
      expect(
        (await edit(made.id, { version: 1, gradePoint: null, description: null })).body.data,
      ).toMatchObject({ gradePoint: null, description: null, version: 2 });
      const same = await edit(made.id, {
        version: 2,
        name: 'A1',
        minPercentage: 91,
        maxPercentage: 100,
        gradePoint: null,
      });
      expect(same.status).toBe(200);
      expect(same.body.data.version).toBe(2);
      expect(await audit(made.id)).toHaveLength(2);
    });

    it('is 409 VERSION_CONFLICT for an old version, and 400 for a missing one or a null name or range', async () => {
      const made = await added();
      await edit(made.id, { version: 1, name: 'x' });
      const old = await edit(made.id, { version: 1, name: 'y' });
      expect(old.status).toBe(409);
      expect(old.body.code).toBe('VERSION_CONFLICT');
      expect((await edit(made.id, { name: 'y' })).status).toBe(400);
      expect(fieldsOf(await edit(made.id, { version: 2, name: null }))).toEqual({
        name: 'INVALID_TYPE',
      });
      expect(fieldsOf(await edit(made.id, { version: 2, maxPercentage: null }))).toEqual({
        maxPercentage: 'INVALID_TYPE',
      });
    });

    it('refuses a grade point, a percentage or a name outside what a band holds (400), writing nothing', async () => {
      const made = await added();
      const cases: [object, Record<string, string>][] = [
        [{ gradePoint: 10.5 }, { gradePoint: 'OUT_OF_RANGE' }],
        [{ gradePoint: -1 }, { gradePoint: 'OUT_OF_RANGE' }],
        [{ minPercentage: 100.01 }, { minPercentage: 'OUT_OF_RANGE' }],
        [{ maxPercentage: 100.01 }, { maxPercentage: 'OUT_OF_RANGE' }],
        [{ minPercentage: 90.555 }, { minPercentage: 'INVALID_TYPE' }],
        [{ name: 'x'.repeat(21) }, { name: 'TOO_LONG' }],
      ];
      for (const [fields, expected] of cases) {
        const res = await edit(made.id, { version: 1, ...fields });
        expect([res.status, fieldsOf(res)]).toEqual([400, expected]);
      }
      expect((await audit(made.id)).map((r) => r.action)).toEqual(['grade_band.created']);
      expect(await bands()).toMatchObject([{ version: 1, gradePoint: 10 }]);
    });

    it('writes no audit entry for an edit that is refused', async () => {
      const top = await added();
      await added({ name: 'A2', minPercentage: 81, maxPercentage: 90.99 });
      expect((await edit(top.id, { version: 1, minPercentage: 90 })).status).toBe(409);
      expect((await edit(top.id, { version: 1, name: 'a2' })).status).toBe(409);
      expect((await edit(top.id, { version: 7, name: 'B' })).status).toBe(409);
      expect(
        (await edit(top.id, { version: 1, minPercentage: 100, maxPercentage: 95 })).status,
      ).toBe(400);
      expect((await edit(top.id, { version: 1, name: 'B' }, teacherToken)).status).toBe(403);
      expect((await edit(top.id, { version: 1, name: 'B' }, secondAdmin.token)).status).toBe(404);
      expect((await audit(top.id)).map((r) => r.action)).toEqual(['grade_band.created']);
      expect(await bands()).toMatchObject([{ name: 'A1', version: 1 }, { name: 'A2' }]);
    });

    it('refuses a minimum above the maximum that stays, on maxPercentage', async () => {
      const made = await added();
      const res = await edit(made.id, { version: 1, minPercentage: 100.0, maxPercentage: 95 });
      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual({ maxPercentage: 'OUT_OF_RANGE' });
      const low = await added({ name: 'E', minPercentage: 0, maxPercentage: 20 });
      const above = await edit(low.id, { version: 1, minPercentage: 25 });
      expect(above.status).toBe(400);
      expect(fieldsOf(above)).toEqual({ maxPercentage: 'OUT_OF_RANGE' });
    });

    it('refuses an overlap with another band (409) and a name another band has, but not its own range', async () => {
      const top = await added();
      await added({ name: 'A2', minPercentage: 81, maxPercentage: 90.99 });
      const over = await edit(top.id, { version: 1, minPercentage: 90 });
      expect(over.status).toBe(409);
      expect(over.body.code).toBe('GRADE_BAND_OVERLAP');
      const taken = await edit(top.id, { version: 1, name: 'a2' });
      expect(taken.status).toBe(409);
      expect(fieldsOf(taken)).toEqual({ name: 'DUPLICATE' });
      expect((await edit(top.id, { version: 1, minPercentage: 92 })).status).toBe(200);
    });

    it('is 403 for a teacher and 404 for the wrong Institution, another Society or a deactivated band', async () => {
      const made = await added();
      expect((await edit(made.id, { version: 1, name: 'x' }, teacherToken)).status).toBe(403);
      expect((await edit(made.id, { version: 1, name: 'x' }, parentToken)).status).toBe(403);
      expect((await edit(made.id, { version: 1, name: 'x' }, secondAdmin.token)).status).toBe(404);
      expect((await edit(made.id, { version: 1, name: 'x' }, otherOwner.token)).status).toBe(404);
      expect((await edit(missing, { version: 1, name: 'x' })).status).toBe(404);
      expect((await edit(made.id, { version: 1, institutionId: second })).status).toBe(400);
      succeeded(await remove(made.id), 200, 'deactivated band');
      expect((await edit(made.id, { version: 2, name: 'x' })).status).toBe(404);
    });
  });

  describe('GRD-04 deactivate', () => {
    it('deactivates, audits, and frees the name and the range', async () => {
      const made = await added();
      const res = await remove(made.id, firstAdmin.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: made.id, status: 0 });
      expect((await audit(made.id)).map((r) => r.action)).toEqual([
        'grade_band.created',
        'grade_band.deactivated',
      ]);
      expect(await added()).toMatchObject({ name: 'A1', minPercentage: 91 });
    });

    it('is 404 the second time, for the wrong Institution and Society, and 403 for a teacher', async () => {
      const made = await added();
      expect((await remove(made.id, teacherToken)).status).toBe(403);
      expect((await remove(made.id, secondAdmin.token)).status).toBe(404);
      expect((await remove(made.id, otherOwner.token)).status).toBe(404);
      expect((await remove(made.id)).status).toBe(200);
      expect((await remove(made.id)).status).toBe(404);
    });

    it('writes no audit entry for a deactivation that is refused', async () => {
      const made = await added();
      expect((await remove(made.id, teacherToken)).status).toBe(403);
      expect((await remove(made.id, parentToken)).status).toBe(403);
      expect((await remove(made.id, secondAdmin.token)).status).toBe(404);
      expect((await remove(missing)).status).toBe(404);
      expect((await audit(made.id)).map((r) => r.action)).toEqual(['grade_band.created']);
      expect((await remove(made.id)).status).toBe(200);
      expect((await remove(made.id)).status).toBe(404);
      expect((await audit(made.id)).map((r) => r.action)).toEqual([
        'grade_band.created',
        'grade_band.deactivated',
      ]);
    });
  });

  describe('what a parent’s row-level security shows', () => {
    it('shows the active bands of the child’s Institution only, and none without a child in the request', async () => {
      const mine = await added();
      const gone = await added({ name: 'B', minPercentage: 50, maxPercentage: 60 });
      await added({ institutionId: second });
      const foreign = await kit.institution(otherOwner.token, categoryId);
      await added({ institutionId: foreign }, otherOwner.token);
      succeeded(await remove(gone.id), 200, 'deactivated band');
      expect(await rowsSeenAsParent([childId])).toEqual([{ id: mine.id, institution_id: first }]);
      expect(await rowsSeenAsParent([])).toEqual([]);
      expect(await rowsSeenAsParent([missing])).toEqual([]);
    });
  });

  describe('the table', () => {
    it('refuses to be deleted from by the app role, and a range outside 0 to 100 or running down', async () => {
      const made = await added();
      await expect(
        database.transaction(asOwner(), (tx) =>
          sql`delete from grade_bands where id = ${made.id}`.execute(tx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      for (const [min, max] of [
        [50, 40],
        [-1, 10],
        [90, 101],
      ]) {
        await expect(
          database.transaction(asOwner(), (tx) =>
            sql`insert into grade_bands (society_id, institution_id, name, min_percentage, max_percentage)
              values (${societyA}, ${first}, 'Z', ${min}, ${max})`.execute(tx),
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('does not let a band name an Institution of another Society', async () => {
      const foreign = await kit.institution(otherOwner.token, categoryId);
      await expect(
        database.transaction({ ...asOwner(), institutionIds: [first, foreign] }, (tx) =>
          sql`insert into grade_bands (society_id, institution_id, name, min_percentage, max_percentage)
              values (${societyA}, ${foreign}, 'Z', 0, 10)`.execute(tx),
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });
});
