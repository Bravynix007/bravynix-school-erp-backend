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

interface Exam {
  id: string;
  institutionId: string;
  academicYearId: string;
  name: string;
  examType: number;
  startDate: string;
  endDate: string;
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

describe('EXM-01 to EXM-04 exams (API design 9.8)', () => {
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
  let year: string;
  let childId: string;
  let categoryId: string;

  const body = (fields: object = {}) => ({
    institutionId: first,
    name: 'Unit Test 1',
    examType: 1,
    startDate: '2026-08-10',
    endDate: '2026-08-14',
    ...fields,
  });
  const add = (fields: object = {}, token = owner.token) =>
    api('post', '/v1/exams', token, body(fields));
  const added = async (fields: object = {}, token = owner.token) => {
    const res = succeeded(await add(fields, token), 201, 'exam');
    return res.body.data as unknown as Exam;
  };
  const read = (query: string, token = owner.token) => api('get', `/v1/exams?${query}`, token);
  const exams = async (query = `institutionId=${first}`, token = owner.token) => {
    const res = await read(query, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Exam[];
  };
  /** The exams a request sees as a parent with these children in it (row-level security). */
  const rowsSeenAsParent = (childIds: string[]) =>
    database.transaction({ personId: owner.person, roleCode: 5, childIds }, (tx) =>
      tx.selectFrom('exams').select(['id', 'institution_id']).execute(),
    );
  const edit = (id: string, fields: object, token = owner.token) =>
    api('patch', `/v1/exams/${id}`, token, fields);
  const remove = (id: string, token = owner.token) => api('delete', `/v1/exams/${id}`, token);
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
    year = await kit.year(owner.token, first);
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

  /** A second academic year of the first Institution, after the current one. */
  const nextYear = () =>
    kit.year(owner.token, first, {
      name: '2027-2028',
      startDate: '2027-04-01',
      endDate: '2028-03-31',
    });

  describe('EXM-02 add', () => {
    it('lets the Owner and the Admin add an exam to the current year, with its dates as written', async () => {
      expect(await added()).toMatchObject({
        institutionId: first,
        academicYearId: year,
        name: 'Unit Test 1',
        examType: 1,
        startDate: '2026-08-10',
        endDate: '2026-08-14',
        status: 1,
        version: 1,
      });
      expect(
        await added(
          { name: 'Annual', examType: 6, startDate: '2027-03-01', endDate: '2027-03-15' },
          firstAdmin.token,
        ),
      ).toMatchObject({ name: 'Annual', examType: 6 });
    });

    it('takes an exam of one day, and one that fills the year', async () => {
      expect(await added({ startDate: '2026-08-10', endDate: '2026-08-10' })).toMatchObject({
        startDate: '2026-08-10',
        endDate: '2026-08-10',
      });
      expect(
        await added({ name: 'Whole year', startDate: '2026-06-01', endDate: '2027-03-31' }),
      ).toMatchObject({ startDate: '2026-06-01', endDate: '2027-03-31' });
    });

    it('refuses a teacher and a parent (403), an Admin of another Institution and another Society (404)', async () => {
      expect((await add({}, teacherToken)).status).toBe(403);
      expect((await add({}, parentToken)).status).toBe(403);
      expect((await add({}, secondAdmin.token)).status).toBe(404);
      expect((await add({}, otherOwner.token)).status).toBe(404);
      expect((await add({ institutionId: missing })).status).toBe(404);
      expect(await exams()).toEqual([]);
    });

    it('refuses what is not an exam (400)', async () => {
      const cases: [object, Record<string, string>][] = [
        [{ name: '' }, { name: 'REQUIRED' }],
        [{ name: 'x'.repeat(101) }, { name: 'TOO_LONG' }],
        [{ name: 7 }, { name: 'INVALID_TYPE' }],
        [{ examType: 0 }, { examType: 'INVALID_CODE' }],
        [{ examType: 7 }, { examType: 'INVALID_CODE' }],
        [{ examType: '1' }, { examType: 'INVALID_TYPE' }],
        [{ startDate: '2026-8-10' }, { startDate: 'INVALID_FORMAT' }],
        [{ endDate: '2027-02-29' }, { endDate: 'INVALID_FORMAT' }],
        [{ startDate: undefined }, { startDate: 'REQUIRED' }],
        [{ status: 0 }, { status: 'FIELD_NOT_ALLOWED' }],
      ];
      for (const [fields, expected] of cases) {
        const res = await add(fields);
        expect([res.status, fieldsOf(res)]).toEqual([400, expected]);
      }
      expect(await exams()).toEqual([]);
    });

    it('refuses dates outside the year, and an end before the start (400 OUT_OF_RANGE)', async () => {
      const cases: [object, Record<string, string>][] = [
        [{ startDate: '2026-08-14', endDate: '2026-08-10' }, { endDate: 'OUT_OF_RANGE' }],
        [{ startDate: '2026-05-31' }, { startDate: 'OUT_OF_RANGE' }],
        [{ endDate: '2027-04-01' }, { endDate: 'OUT_OF_RANGE' }],
        [
          { startDate: '2027-04-01', endDate: '2027-04-02' },
          { startDate: 'OUT_OF_RANGE', endDate: 'OUT_OF_RANGE' },
        ],
      ];
      for (const [fields, expected] of cases) {
        const res = await add(fields);
        expect([res.status, fieldsOf(res)]).toEqual([400, expected]);
      }
      expect(await exams()).toEqual([]);
    });

    it('refuses a name in use among the year’s active exams in any letter case (409 DUPLICATE)', async () => {
      await added();
      for (const name of ['Unit Test 1', 'unit test 1', 'UNIT TEST 1 ']) {
        const res = await add({ name });
        expect([res.status, fieldsOf(res)]).toEqual([409, { name: 'DUPLICATE' }]);
      }
      expect(await exams()).toHaveLength(1);
    });

    it('lets two Institutions and two years use one name', async () => {
      const next = await nextYear();
      await added();
      expect(
        await added({ academicYearId: next, startDate: '2027-08-09', endDate: '2027-08-13' }),
      ).toMatchObject({
        academicYearId: next,
      });
      const secondYear = await kit.year(owner.token, second);
      expect(
        await added({ institutionId: second, academicYearId: secondYear }, secondAdmin.token),
      ).toMatchObject({
        institutionId: second,
      });
    });

    it('frees the name when the exam is deactivated', async () => {
      const made = await added();
      expect((await remove(made.id)).status).toBe(200);
      expect(await added()).toMatchObject({ name: 'Unit Test 1' });
    });

    it('lets only one of eight exams of one name saved at once in', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => add()));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      expect(await exams()).toHaveLength(1);
    });

    it('is 422 CURRENT_YEAR_REQUIRED for an Institution with no current year', async () => {
      const bare = await add({ institutionId: second });
      expect(bare.status).toBe(422);
      expect(bare.body.code).toBe('CURRENT_YEAR_REQUIRED');
    });

    it('adds to the year named, refuses a year that is deactivated (422 REFERENCE_INACTIVE) and one of another Institution (404)', async () => {
      const next = await nextYear();
      const made = await added({
        academicYearId: next,
        startDate: '2027-08-09',
        endDate: '2027-08-13',
      });
      expect(made.academicYearId).toBe(next);
      expect((await api('delete', `/v1/academic-years/${next}`, owner.token)).status).toBe(200);
      const closed = await add({
        academicYearId: next,
        name: 'Other',
        startDate: '2027-08-09',
        endDate: '2027-08-13',
      });
      expect(closed.status).toBe(422);
      expect(fieldsOf(closed)).toEqual({ academicYearId: 'REFERENCE_INACTIVE' });
      const elsewhere = await kit.year(owner.token, second);
      expect((await add({ academicYearId: elsewhere })).status).toBe(404);
    });

    it('checks the dates against the year named, not the current one', async () => {
      const next = await nextYear();
      const res = await add({ academicYearId: next });
      expect([res.status, fieldsOf(res)]).toEqual([
        400,
        { startDate: 'OUT_OF_RANGE', endDate: 'OUT_OF_RANGE' },
      ]);
    });

    it('writes one audit entry that names the Institution, and none for a refusal', async () => {
      expect((await add({ name: '' })).status).toBe(400);
      expect((await add({ startDate: '2025-01-01' })).status).toBe(400);
      const made = await added();
      expect((await add()).status).toBe(409);
      const rows = await audit(made.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'exam.created',
        institution_id: first,
        society_id: societyA,
        new_values: {
          name: 'Unit Test 1',
          exam_type: 1,
          start_date: '2026-08-10',
          end_date: '2026-08-14',
        },
      });
    });
  });

  describe('EXM-01 list', () => {
    it('shows the current year’s exams, the earliest first, to the Owner, the Admin and a teacher', async () => {
      await added({ name: 'Annual', examType: 6, startDate: '2027-03-01', endDate: '2027-03-15' });
      await added({ name: 'Unit Test 1' });
      await added({ name: 'Term 1', examType: 2, startDate: '2026-09-21', endDate: '2026-09-30' });
      for (const token of [owner.token, firstAdmin.token, teacherToken]) {
        expect((await exams(`institutionId=${first}`, token)).map((e) => e.name)).toEqual([
          'Unit Test 1',
          'Term 1',
          'Annual',
        ]);
      }
    });

    it('shows the year named, and leaves out a deactivated exam and another year’s', async () => {
      const next = await nextYear();
      const old = await added();
      await added({
        name: 'Next',
        academicYearId: next,
        startDate: '2027-08-09',
        endDate: '2027-08-13',
      });
      await added({ name: 'Gone', startDate: '2026-09-01', endDate: '2026-09-02' });
      const gone = (await exams()).find((e) => e.name === 'Gone')!;
      expect((await remove(gone.id)).status).toBe(200);
      expect((await exams()).map((e) => e.id)).toEqual([old.id]);
      expect(
        (await exams(`institutionId=${first}&academicYearId=${next}`)).map((e) => e.name),
      ).toEqual(['Next']);
    });

    it('is 404 for a year of another Institution, and for an Institution out of scope', async () => {
      const elsewhere = await kit.year(owner.token, second);
      expect((await read(`institutionId=${first}&academicYearId=${elsewhere}`)).status).toBe(404);
      expect((await read(`institutionId=${first}`, secondAdmin.token)).status).toBe(404);
      expect((await read(`institutionId=${first}`, otherOwner.token)).status).toBe(404);
    });

    it('asks for the Institution (400), and is 422 CURRENT_YEAR_REQUIRED for one with no current year', async () => {
      const none = await read('');
      expect([none.status, fieldsOf(none)]).toEqual([400, { institutionId: 'REQUIRED' }]);
      const bare = await read(`institutionId=${second}`);
      expect(bare.status).toBe(422);
      expect(bare.body.code).toBe('CURRENT_YEAR_REQUIRED');
    });

    it('lets a parent read their child’s Institution, and nothing else', async () => {
      await added();
      const secondYear = await kit.year(owner.token, second);
      await added({ institutionId: second, academicYearId: secondYear, name: 'Other' });
      const mine = await exams(`studentId=${childId}`, parentToken);
      expect(mine.map((e) => [e.institutionId, e.name])).toEqual([[first, 'Unit Test 1']]);
      expect((await read(`studentId=${childId}`, strangerToken)).status).toBe(404);
      const none = await read('', parentToken);
      expect([none.status, fieldsOf(none)]).toEqual([400, { studentId: 'REQUIRED' }]);
      const named = await read(`studentId=${childId}&institutionId=${first}`, parentToken);
      expect([named.status, fieldsOf(named)]).toEqual([
        400,
        { institutionId: 'FIELD_NOT_ALLOWED' },
      ]);
      const yeared = await read(`studentId=${childId}&academicYearId=${year}`, parentToken);
      expect([yeared.status, fieldsOf(yeared)]).toEqual([
        400,
        { academicYearId: 'FIELD_NOT_ALLOWED' },
      ]);
      const staff = await read(`institutionId=${first}&studentId=${childId}`);
      expect([staff.status, fieldsOf(staff)]).toEqual([400, { studentId: 'FIELD_NOT_ALLOWED' }]);
    });
  });

  describe('EXM-03 edit', () => {
    it('changes the name, the type and the dates, bumps the version, and audits before and after', async () => {
      const made = await added();
      const res = await edit(made.id, {
        version: 1,
        name: 'Term 1',
        examType: 2,
        startDate: '2026-09-21',
        endDate: '2026-09-30',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        name: 'Term 1',
        examType: 2,
        startDate: '2026-09-21',
        endDate: '2026-09-30',
        version: 2,
      });
      const rows = await audit(made.id);
      expect(rows.map((r) => r.action)).toEqual(['exam.created', 'exam.updated']);
      expect(rows[1]).toMatchObject({
        old_values: { name: 'Unit Test 1', exam_type: 1, start_date: '2026-08-10' },
        new_values: { name: 'Term 1', exam_type: 2, start_date: '2026-09-21' },
      });
    });

    it('lets the Admin edit, and refuses a teacher and a parent (403), another Institution’s Admin and Society (404)', async () => {
      const made = await added();
      expect((await edit(made.id, { version: 1, name: 'A' }, firstAdmin.token)).status).toBe(200);
      expect((await edit(made.id, { version: 2, name: 'B' }, teacherToken)).status).toBe(403);
      expect((await edit(made.id, { version: 2, name: 'B' }, parentToken)).status).toBe(403);
      expect((await edit(made.id, { version: 2, name: 'B' }, secondAdmin.token)).status).toBe(404);
      expect((await edit(made.id, { version: 2, name: 'B' }, otherOwner.token)).status).toBe(404);
      expect((await edit(missing, { version: 1, name: 'B' })).status).toBe(404);
    });

    it('is 409 VERSION_CONFLICT for a stale version, before anything else', async () => {
      const made = await added();
      expect((await edit(made.id, { version: 1, name: 'A' })).status).toBe(200);
      const stale = await edit(made.id, { version: 1, name: 'B' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
    });

    it('writes nothing for a request that changes nothing', async () => {
      const made = await added();
      const res = await edit(made.id, { version: 1, name: 'Unit Test 1', startDate: '2026-08-10' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ version: 1 });
      expect(await audit(made.id)).toHaveLength(1);
    });

    it('checks a date against the one that stays, and against the year', async () => {
      const made = await added();
      const early = await edit(made.id, { version: 1, endDate: '2026-08-09' });
      expect([early.status, fieldsOf(early)]).toEqual([400, { endDate: 'OUT_OF_RANGE' }]);
      const late = await edit(made.id, { version: 1, startDate: '2026-08-15' });
      expect([late.status, fieldsOf(late)]).toEqual([400, { endDate: 'OUT_OF_RANGE' }]);
      const outside = await edit(made.id, { version: 1, endDate: '2027-04-01' });
      expect([outside.status, fieldsOf(outside)]).toEqual([400, { endDate: 'OUT_OF_RANGE' }]);
      expect((await edit(made.id, { version: 1, startDate: '2026-08-14' })).status).toBe(200);
      expect(await audit(made.id)).toHaveLength(2);
    });

    it('renames an exam whose year was shortened since, but refuses a date that is outside it', async () => {
      const made = await added({ startDate: '2027-03-01', endDate: '2027-03-15' });
      const shrunk = await api('patch', `/v1/academic-years/${year}`, owner.token, {
        version: 1,
        endDate: '2026-12-31',
      });
      expect(shrunk.status).toBe(200);
      const renamed = await edit(made.id, { version: 1, name: 'Annual' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toMatchObject({ name: 'Annual', endDate: '2027-03-15' });
      const moved = await edit(made.id, { version: 2, endDate: '2027-03-16' });
      expect(moved.status).toBe(400);
      expect(fieldsOf(moved)).toMatchObject({ endDate: 'OUT_OF_RANGE' });
    });

    it('refuses a name of another active exam of the year (409 DUPLICATE), but not its own', async () => {
      const one = await added();
      const two = await added({ name: 'Term 1' });
      const res = await edit(two.id, { version: 1, name: 'unit test 1' });
      expect([res.status, fieldsOf(res)]).toEqual([409, { name: 'DUPLICATE' }]);
      expect((await edit(one.id, { version: 1, name: 'UNIT TEST 1' })).status).toBe(200);
    });

    it('refuses what cannot change, and what is not an exam (400)', async () => {
      const made = await added();
      const cases: [object, Record<string, string>][] = [
        [{ institutionId: second }, { institutionId: 'FIELD_NOT_ALLOWED' }],
        [{ academicYearId: year }, { academicYearId: 'FIELD_NOT_ALLOWED' }],
        [{ name: null }, { name: 'INVALID_TYPE' }],
        [{ examType: 9 }, { examType: 'INVALID_CODE' }],
        [{ startDate: '2026-02-30' }, { startDate: 'INVALID_FORMAT' }],
      ];
      for (const [fields, expected] of cases) {
        const res = await edit(made.id, { version: 1, ...fields });
        expect([res.status, fieldsOf(res)]).toEqual([400, expected]);
      }
      expect((await edit(made.id, {})).status).toBe(400);
    });

    it('is 404 for a deactivated exam', async () => {
      const made = await added();
      expect((await remove(made.id)).status).toBe(200);
      expect((await edit(made.id, { version: 2, name: 'A' })).status).toBe(404);
    });
  });

  describe('EXM-04 deactivate', () => {
    it('deactivates, frees the name, hides the exam, and audits it', async () => {
      const made = await added();
      const res = await remove(made.id);
      expect([res.status, res.body.data]).toEqual([200, { id: made.id, status: 0 }]);
      expect(await exams()).toEqual([]);
      expect((await remove(made.id)).status).toBe(404);
      const rows = await audit(made.id);
      expect(rows.map((r) => r.action)).toEqual(['exam.created', 'exam.deactivated']);
      expect(rows[1]).toMatchObject({
        institution_id: first,
        old_values: { status: 1 },
        new_values: { status: 0 },
      });
    });

    it('is for the Owner and the Admin; a teacher and a parent are refused (403), others see nothing (404)', async () => {
      const made = await added();
      expect((await remove(made.id, teacherToken)).status).toBe(403);
      expect((await remove(made.id, parentToken)).status).toBe(403);
      expect((await remove(made.id, secondAdmin.token)).status).toBe(404);
      expect((await remove(made.id, otherOwner.token)).status).toBe(404);
      expect((await remove(missing)).status).toBe(404);
      expect((await remove(made.id, firstAdmin.token)).status).toBe(200);
    });
  });

  describe('what a parent’s row-level security shows', () => {
    it('shows the active exams of the child’s Institution only, and none without a child in the request', async () => {
      const mine = await added();
      const gone = await added({ name: 'Gone', startDate: '2026-09-01', endDate: '2026-09-02' });
      const foreign = await kit.institution(otherOwner.token, categoryId);
      const foreignYear = await kit.year(otherOwner.token, foreign);
      await added({ institutionId: foreign, academicYearId: foreignYear }, otherOwner.token);
      succeeded(await remove(gone.id), 200, 'deactivated exam');
      expect(await rowsSeenAsParent([childId])).toEqual([{ id: mine.id, institution_id: first }]);
      expect(await rowsSeenAsParent([])).toEqual([]);
      expect(await rowsSeenAsParent([missing])).toEqual([]);
    });
  });

  describe('the table', () => {
    it('refuses to be deleted from by the app role, and an end before the start or a type outside 1 to 6', async () => {
      const made = await added();
      await expect(
        database.transaction(asOwner(), (tx) =>
          sql`delete from exams where id = ${made.id}`.execute(tx),
        ),
      ).rejects.toThrow();
      await expect(
        database.transaction(asOwner(), (tx) =>
          sql`update exams set end_date = date '2026-08-01' where id = ${made.id}`.execute(tx),
        ),
      ).rejects.toThrow(/ck_exams_dates/);
      await expect(
        database.transaction(asOwner(), (tx) =>
          sql`update exams set exam_type = 7 where id = ${made.id}`.execute(tx),
        ),
      ).rejects.toThrow(/ck_exams_type/);
      expect(await exams()).toHaveLength(1);
    });

    it('refuses an exam whose year belongs to another Institution', async () => {
      const elsewhere = await kit.year(owner.token, second);
      await expect(
        database.transaction(asOwner(), (tx) =>
          sql`
            insert into exams (society_id, institution_id, academic_year_id, name, exam_type, start_date, end_date)
            values (${societyA}, ${first}, ${elsewhere}, 'Stray', 1, date '2026-08-10', date '2026-08-14')
          `.execute(tx),
        ),
      ).rejects.toThrow(/fk_exams_year/);
    });

    it('keeps another Society’s exams out of sight', async () => {
      await added();
      const foreign = await kit.institution(otherOwner.token, categoryId);
      const foreignYear = await kit.year(otherOwner.token, foreign);
      await added({ institutionId: foreign, academicYearId: foreignYear }, otherOwner.token);
      const seen = await database.transaction(asOwner(), (tx) =>
        tx.selectFrom('exams').select('institution_id').execute(),
      );
      expect(seen).toEqual([{ institution_id: first }]);
    });
  });
});
