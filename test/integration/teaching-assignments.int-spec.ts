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
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;
const missing = '00000000-0000-7000-8000-00000000ffff';

interface Entry {
  id: string;
  code: string;
}
interface StaffData {
  id: string;
  classTeachers: { academicYearId: string; sectionId: string }[];
  person: { id: string; email: string };
}
interface AssignmentBody {
  id: string;
  institutionId: string;
  academicYearId: string;
  section: { id: string; displayName: string; classId: string; className: string };
  subject: { id: string; name: string };
  staffMember: { id: string; firstName: string; lastName: string | null };
}

const rowsOf = (res: { body: { data: unknown } }) => res.body.data as unknown as AssignmentBody[];

/** STF-09 and ASG-01 to ASG-03 (API design 9.5, 10.5a): who leads and who teaches which section. */
describe('class teachers and teaching assignments', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const staffUsers: string[] = [];

  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let societyA: string;
  let first: string;
  let second: string;
  let categoryId: string;
  let year: string;
  let classId: string;
  let sectionA: string;
  let sectionB: string;
  let math: string;
  let teacher: StaffData;
  let other: StaffData;

  const masters = async (type: string) =>
    (await api('get', `/v1/masters/${type}`, admin)).body.data as unknown as Entry[];

  const makeSociety = async () => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    societies.push(res.body.data.id);
    return res.body.data.id as string;
  };
  const makeInstitution = async (token: string) => {
    const res = await api('post', '/v1/institutions', token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
      classesOffered: [categoryId],
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };
  const makeYear = async (institutionId: string, fields: object = {}) => {
    const res = await api('post', '/v1/academic-years', owner.token, {
      institutionId,
      name: '2026-2027',
      startDate: '2026-06-01',
      endDate: '2027-03-31',
      ...fields,
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };
  const makeClass = async (institutionId: string, predefinedClassId: string) => {
    const res = await api('post', '/v1/classes', owner.token, { institutionId, predefinedClassId });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };
  const makeSection = async (cls: string, predefinedSectionId: string) => {
    const res = await api('post', '/v1/sections', owner.token, {
      classId: cls,
      predefinedSectionId,
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };
  /** A section of the other Institution, which the teacher's home is not. */
  const sectionOfSecond = async () => {
    const classes = await masters('predefined-classes');
    const sectionCodes = await masters('predefined-sections');
    const secondClass = await makeClass(second, classes.find((c) => c.code === 'C09')!.id);
    return makeSection(secondClass, sectionCodes.find((s) => s.code === 'A')!.id);
  };
  const makeSubject = async (name = `Subject ${newId().slice(-6)}`) => {
    const res = await api('post', '/v1/subjects', owner.token, { name });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };
  const added = async (fields: object = {}) => {
    const res = await api('post', '/v1/staff', owner.token, {
      homeInstitutionId: first,
      email: `${newId()}@staff.test`,
      firstName: 'Meera',
      classCategoryId: categoryId,
      mobile: { countryCode: '91', number: '9876500001' },
      ...fields,
    });
    expect(res.status).toBe(201);
    const staff = res.body.data as unknown as StaffData;
    staffUsers.push(staff.person.id);
    return staff;
  };
  const teachesMath = async (staff: StaffData, subjectIds = [math]) => {
    const res = await api('put', `/v1/staff/${staff.id}/subjects`, owner.token, { subjectIds });
    expect(res.status).toBe(200);
  };
  const actingAs = async (address: string, roleCode: number) => {
    const login = await signInMobile(t, address);
    const chosen = await api('post', '/v1/auth/context', login.accessToken, {
      roleCode,
      societyId: societyA,
    });
    expect(chosen.status).toBe(200);
    return chosen.body.data.accessToken as string;
  };

  const lead = (id: string, sectionId: string | null, academicYearId = year, token = owner.token) =>
    api('put', `/v1/staff/${id}/class-teacher`, token, { academicYearId, sectionId });
  const rawLead = (body: object) =>
    api('put', `/v1/staff/${teacher.id}/class-teacher`, owner.token, body);
  const assign = (fields: object = {}, token = owner.token) =>
    api('post', '/v1/teaching-assignments', token, {
      staffMemberId: teacher.id,
      academicYearId: year,
      sectionId: sectionA,
      subjectId: math,
      ...fields,
    });
  const assigned = async (fields: object = {}) => {
    const res = await assign(fields);
    expect(res.status).toBe(201);
    return res.body.data as unknown as AssignmentBody;
  };
  const list = (query: string, token = owner.token) =>
    api('get', `/v1/teaching-assignments?institutionId=${first}${query}`, token);
  const tenantA = () => ({
    personId: owner.person,
    roleCode: 2,
    societyId: societyA,
    institutionIds: [first],
  });
  const total = async (query: string, token = owner.token) =>
    (await list(query, token)).body.meta!.totalItems;
  const profile = async (id: string) =>
    (await api('get', `/v1/staff/${id}`, owner.token)).body.data as unknown as StaffData;
  /** The rows of the home Institution, as its Owner reads them: ended ones stay, and come first (the clock may not tick between requests). */
  const history = (table: 'class_teacher_assignments' | 'teaching_assignments', id: string) =>
    database.transaction(
      { personId: owner.person, roleCode: 2, societyId: societyA, institutionIds: [first] },
      async (tx) =>
        (
          await sql<{ section_id: string; ended_at: Date | null; ended_by: string | null }>`
            select section_id, ended_at, ended_by from ${sql.table(table)}
            where staff_member_id = ${id} order by ended_at is null, created_at, id`.execute(tx)
        ).rows,
    );
  const audit = (id: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      institution_id: string;
      entity_type: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${id}`);

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
    const categories = await masters('class-categories');
    categoryId = categories.find((c) => c.code === 'HIGH_SCHOOL')!.id;
    const classes = await masters('predefined-classes');
    const sectionCodes = await masters('predefined-sections');
    societyA = await makeSociety();
    owner = await fixtures.owner(societyA);
    first = await makeInstitution(owner.token);
    second = await makeInstitution(owner.token);
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
    year = await makeYear(first);
    classId = await makeClass(first, classes.find((c) => c.code === 'C09')!.id);
    sectionA = await makeSection(classId, sectionCodes.find((s) => s.code === 'A')!.id);
    sectionB = await makeSection(classId, sectionCodes.find((s) => s.code === 'B')!.id);
    math = await makeSubject('Mathematics');
    teacher = await added({ firstName: 'Meera', lastName: 'Rao' });
    other = await added({ firstName: 'Anil' });
    await teachesMath(teacher);
    await teachesMath(other);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    for (const id of staffUsers.splice(0)) {
      await sql`delete from role_assignments where user_id = ${id}`.execute(ownerDb);
      await sql`delete from users where id = ${id}`.execute(ownerDb);
    }
    await fixtures.cleanup();
  });

  describe('STF-09 set the class teacher', () => {
    it('makes the teacher the class teacher of the section, shows it on the profile, and audits it', async () => {
      const res = await lead(teacher.id, sectionA, year, institutionAdmin.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ academicYearId: year, sectionId: sectionA });
      expect((await profile(teacher.id)).classTeachers).toEqual([
        { academicYearId: year, sectionId: sectionA },
      ]);
      const entry = (await audit(teacher.id)).find(
        (e) => e.action === 'staff.class_teacher_changed',
      );
      expect(entry).toMatchObject({
        actor_user_id: institutionAdmin.person,
        institution_id: first,
        entity_type: 'staff_member',
      });
      // Changed fields only (DDD 9.12): the year is the same before and after.
      expect(entry?.old_values).toEqual({ sectionId: null });
      expect(entry?.new_values).toEqual({ sectionId: sectionA });
    });

    it('moves a teacher who leads another section: the old row ends and stays as history', async () => {
      await lead(teacher.id, sectionA);
      const res = await lead(teacher.id, sectionB);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ academicYearId: year, sectionId: sectionB });
      expect((await profile(teacher.id)).classTeachers).toEqual([
        { academicYearId: year, sectionId: sectionB },
      ]);
      const rows = await history('class_teacher_assignments', teacher.id);
      expect(rows.map((r) => [r.section_id, r.ended_at !== null, r.ended_by])).toEqual([
        [sectionA, true, owner.person],
        [sectionB, false, null],
      ]);
      const last = (await audit(teacher.id)).findLast(
        (e) => e.action === 'staff.class_teacher_changed',
      );
      expect(last?.old_values).toEqual({ sectionId: sectionA });
      expect(last?.new_values).toEqual({ sectionId: sectionB });
    });

    it('writes nothing when the teacher already leads that section', async () => {
      await lead(teacher.id, sectionA);
      const before = (await audit(teacher.id)).length;
      const res = await lead(teacher.id, sectionA);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ academicYearId: year, sectionId: sectionA });
      expect(await history('class_teacher_assignments', teacher.id)).toHaveLength(1);
      expect(await audit(teacher.id)).toHaveLength(before);
    });

    it('answers 409 CLASS_TEACHER_TAKEN when another teacher leads the section, and changes nothing', async () => {
      await lead(teacher.id, sectionA);
      await lead(other.id, sectionB);
      const res = await lead(other.id, sectionA);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLASS_TEACHER_TAKEN');
      expect((await profile(other.id)).classTeachers).toEqual([
        { academicYearId: year, sectionId: sectionB },
      ]);
      expect((await profile(teacher.id)).classTeachers).toEqual([
        { academicYearId: year, sectionId: sectionA },
      ]);
    });

    it('takes the section once the other teacher has stepped down', async () => {
      await lead(teacher.id, sectionA);
      expect((await lead(teacher.id, null)).status).toBe(200);
      expect((await lead(other.id, sectionA)).status).toBe(200);
    });

    it('ends the assignment with null, audits it, and answers 200 again when there is none', async () => {
      await lead(teacher.id, sectionA);
      const res = await lead(teacher.id, null);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      expect((await profile(teacher.id)).classTeachers).toEqual([]);
      const entry = (await audit(teacher.id)).findLast(
        (e) => e.action === 'staff.class_teacher_changed',
      );
      expect(entry?.old_values).toEqual({ sectionId: sectionA });
      expect(entry?.new_values).toEqual({ sectionId: null });
      const before = (await audit(teacher.id)).length;
      expect((await lead(teacher.id, null)).status).toBe(200);
      expect(await audit(teacher.id)).toHaveLength(before);
    });

    it('keeps the years apart: the same teacher may lead a section in each year', async () => {
      const next = await makeYear(first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      await lead(teacher.id, sectionA);
      expect((await lead(teacher.id, sectionB, next)).status).toBe(200);
      expect((await profile(teacher.id)).classTeachers).toHaveLength(2);
    });

    it('validates the body: 400 for a missing, mistyped or extra field', async () => {
      const noSection = await rawLead({ academicYearId: year });
      expect(noSection.status).toBe(400);
      expect(noSection.body.errors).toMatchObject([{ field: 'sectionId', code: 'INVALID_FORMAT' }]);
      const badYear = await rawLead({ academicYearId: 5, sectionId: sectionA });
      expect(badYear.status).toBe(400);
      expect(badYear.body.errors).toMatchObject([{ field: 'academicYearId' }]);
      const extra = await rawLead({ academicYearId: year, sectionId: sectionA, role: 1 });
      expect(extra.status).toBe(400);
      expect(extra.body.errors).toMatchObject([{ field: 'role', code: 'FIELD_NOT_ALLOWED' }]);
    });

    it('answers 404 for a staff member, year or section that is not there, and for another Institution’s year', async () => {
      expect((await lead(missing, sectionA)).status).toBe(404);
      const noYear = await lead(teacher.id, sectionA, missing);
      expect(noYear.status).toBe(404);
      const noSection = await lead(teacher.id, missing);
      expect(noSection.status).toBe(404);
      const yearOfSecond = await makeYear(second);
      expect((await lead(teacher.id, sectionA, yearOfSecond)).status).toBe(404);
    });

    it('answers 422 REFERENCE_INACTIVE for a deactivated year or section', async () => {
      const spare = await makeYear(first, {
        name: '2025-2026',
        startDate: '2025-06-01',
        endDate: '2026-03-31',
      });
      expect((await api('delete', `/v1/academic-years/${spare}`, owner.token)).status).toBe(200);
      const inactiveYear = await lead(teacher.id, sectionA, spare);
      expect(inactiveYear.status).toBe(422);
      expect(inactiveYear.body.errors).toMatchObject([
        { field: 'academicYearId', code: 'REFERENCE_INACTIVE' },
      ]);
      expect((await api('delete', `/v1/sections/${sectionB}`, owner.token)).status).toBe(200);
      const inactiveSection = await lead(teacher.id, sectionB);
      expect(inactiveSection.status).toBe(422);
      expect(inactiveSection.body.errors).toMatchObject([
        { field: 'sectionId', code: 'REFERENCE_INACTIVE' },
      ]);
    });

    it('answers 404 for a section of another Institution, even one the teacher is an extra member of: extra Institutions are view only', async () => {
      const secondSection = await sectionOfSecond();
      expect((await lead(teacher.id, secondSection)).status).toBe(404);
      const extra = await api('put', `/v1/staff/${teacher.id}/institutions`, owner.token, {
        institutionIds: [second],
      });
      expect(extra.status).toBe(200);
      expect((await lead(teacher.id, secondSection)).status).toBe(404);
    });

    it('answers 422 STAFF_BLOCKED for a blocked teacher, who may still step down', async () => {
      await lead(teacher.id, sectionA);
      expect((await api('post', `/v1/staff/${teacher.id}/block`, owner.token)).status).toBe(200);
      const res = await lead(teacher.id, sectionB);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('STAFF_BLOCKED');
      expect((await lead(teacher.id, null)).status).toBe(200);
    });

    it('answers 404 for a deactivated staff member', async () => {
      await api('delete', `/v1/staff/${teacher.id}`, owner.token);
      expect((await lead(teacher.id, sectionA)).status).toBe(404);
    });

    it('reaches the Owner and the Admin of the Institution only', async () => {
      const outsider = await fixtures.institutionAdmin(societyA, [second]);
      expect((await lead(teacher.id, sectionA, year, outsider.token)).status).toBe(404);
      const teacherToken = await actingAs(teacher.person.email, TEACHER);
      expect((await lead(teacher.id, sectionA, year, teacherToken)).status).toBe(403);
      const otherSociety = await makeSociety();
      const foreignOwner = await fixtures.owner(otherSociety);
      expect((await lead(teacher.id, sectionA, year, foreignOwner.token)).status).toBe(404);
      expect((await profile(teacher.id)).classTeachers).toEqual([]);
    });
  });

  describe('ASG-02 assign a teacher to a section and subject', () => {
    it('creates the assignment with the names, and audits it', async () => {
      const res = await assign({}, institutionAdmin.token);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        institutionId: first,
        academicYearId: year,
        section: { id: sectionA, displayName: expect.any(String), classId, className: '9th' },
        subject: { id: math, name: 'Mathematics' },
        staffMember: { id: teacher.id, firstName: 'Meera', lastName: 'Rao' },
      });
      const entry = (await audit(res.body.data.id as string)).find(
        (e) => e.action === 'assignment.created',
      );
      expect(entry).toMatchObject({
        actor_user_id: institutionAdmin.person,
        institution_id: first,
        entity_type: 'teaching_assignment',
      });
      expect(entry?.new_values).toEqual({
        staffMemberId: teacher.id,
        academicYearId: year,
        sectionId: sectionA,
        subjectId: math,
      });
    });

    it('answers 422 SUBJECT_NOT_TAUGHT for a subject the teacher cannot teach, and 409 DUPLICATE for the same assignment', async () => {
      const art = await makeSubject('Art');
      const refused = await assign({ subjectId: art });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('SUBJECT_NOT_TAUGHT');
      await assigned();
      const duplicate = await assign();
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.errors).toMatchObject([{ field: 'subjectId', code: 'DUPLICATE' }]);
    });

    it('lets two teachers share a section and subject, and one teacher teach it in two sections', async () => {
      await assigned();
      await assigned({ staffMemberId: other.id });
      await assigned({ sectionId: sectionB });
      expect(await total('')).toBe(3);
    });

    it('takes the assignment again once it has ended', async () => {
      const first1 = await assigned();
      expect(
        (await api('delete', `/v1/teaching-assignments/${first1.id}`, owner.token)).status,
      ).toBe(200);
      const again = await assigned();
      expect(again.id).not.toBe(first1.id);
      expect(await history('teaching_assignments', teacher.id)).toHaveLength(2);
    });

    it('answers 404 for a record, year, section or subject that is not there, 422 for a deactivated subject', async () => {
      expect((await assign({ staffMemberId: missing })).status).toBe(404);
      expect((await assign({ academicYearId: missing })).status).toBe(404);
      expect((await assign({ sectionId: missing })).status).toBe(404);
      expect((await assign({ subjectId: missing })).status).toBe(404);
      const art = await makeSubject('Art');
      await teachesMath(teacher, [math, art]);
      expect((await api('delete', `/v1/subjects/${art}`, owner.token)).status).toBe(200);
      const inactive = await assign({ subjectId: art });
      expect(inactive.status).toBe(422);
      expect(inactive.body.errors).toMatchObject([
        { field: 'subjectId', code: 'REFERENCE_INACTIVE' },
      ]);
    });

    it('answers 404 for a section of another Institution and 422 STAFF_BLOCKED for a blocked teacher', async () => {
      expect((await assign({ sectionId: await sectionOfSecond() })).status).toBe(404);
      await api('post', `/v1/staff/${teacher.id}/block`, owner.token);
      const blocked = await assign();
      expect(blocked.status).toBe(422);
      expect(blocked.body.code).toBe('STAFF_BLOCKED');
    });

    it('validates the body: all four fields are required, and nothing else is allowed', async () => {
      const res = await api('post', '/v1/teaching-assignments', owner.token, { role: 1 });
      expect(res.status).toBe(400);
      expect(
        (res.body.errors as { field: string; code: string }[])
          .map((e) => [e.field, e.code])
          .toSorted(),
      ).toEqual([
        ['academicYearId', 'INVALID_FORMAT'],
        ['role', 'FIELD_NOT_ALLOWED'],
        ['sectionId', 'INVALID_FORMAT'],
        ['staffMemberId', 'INVALID_FORMAT'],
        ['subjectId', 'INVALID_FORMAT'],
      ]);
    });

    it('reaches the Owner and the Admin of the Institution only', async () => {
      const outsider = await fixtures.institutionAdmin(societyA, [second]);
      expect((await assign({}, outsider.token)).status).toBe(404);
      const teacherToken = await actingAs(teacher.person.email, TEACHER);
      expect((await assign({}, teacherToken)).status).toBe(403);
      expect(await history('teaching_assignments', teacher.id)).toEqual([]);
    });
  });

  describe('ASG-01 list the assignments', () => {
    it('lists the current year by teacher name, with a page at a time', async () => {
      await assigned();
      await assigned({ staffMemberId: other.id, sectionId: sectionB });
      const res = await list('');
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, totalItems: 2, totalPages: 1 });
      expect(rowsOf(res).map((row) => row.staffMember.firstName)).toEqual(['Anil', 'Meera']);
      const paged = await list('&limit=1&page=2');
      expect(paged.body.meta).toEqual({ page: 2, limit: 1, totalItems: 2, totalPages: 2 });
      expect(paged.body.data).toHaveLength(1);
      expect(rowsOf(paged)[0]!.staffMember.firstName).toBe('Meera');
    });

    it('filters by section, subject and teacher', async () => {
      const art = await makeSubject('Art');
      await teachesMath(teacher, [math, art]);
      await assigned();
      await assigned({ sectionId: sectionB, subjectId: art });
      await assigned({ staffMemberId: other.id });
      expect(await total(`&sectionId=${sectionB}`)).toBe(1);
      expect(await total(`&subjectId=${math}`)).toBe(2);
      expect(await total(`&staffMemberId=${other.id}`)).toBe(1);
      expect(await total(`&staffMemberId=${teacher.id}&subjectId=${art}`)).toBe(1);
    });

    it('reads another year when it is named, and an Institution with no current year has none to list', async () => {
      const next = await makeYear(first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      await assigned();
      expect(await total(`&academicYearId=${next}`)).toBe(0);
      expect(await total(`&academicYearId=${year}`)).toBe(1);
      expect(
        (await api('post', `/v1/academic-years/${next}/make-current`, owner.token, { version: 1 }))
          .status,
      ).toBe(200);
      expect(await total('')).toBe(0);
      const bare = await api(
        'get',
        `/v1/teaching-assignments?institutionId=${second}`,
        owner.token,
      );
      expect(bare.status).toBe(200);
      expect(bare.body.data).toEqual([]);
      expect(bare.body.meta!.totalItems).toBe(0);
    });

    it('shows a teacher their own assignments and nobody else’s', async () => {
      await assigned();
      await assigned({ staffMemberId: other.id });
      const token = await actingAs(teacher.person.email, TEACHER);
      const own = await list('', token);
      expect(own.status).toBe(200);
      expect(own.body.meta!.totalItems).toBe(1);
      expect(rowsOf(own)[0]!.staffMember.id).toBe(teacher.id);
      expect(await total(`&staffMemberId=${teacher.id}`, token)).toBe(1);
      const theirs = await list(`&staffMemberId=${other.id}`, token);
      expect(theirs.status).toBe(200);
      expect(theirs.body.data).toEqual([]);
    });

    it('rejects q and sort, and a missing or malformed institutionId', async () => {
      expect((await list('&q=x')).status).toBe(400);
      expect((await list('&sort=name')).status).toBe(400);
      expect((await api('get', '/v1/teaching-assignments', owner.token)).status).toBe(400);
      expect(
        (await api('get', '/v1/teaching-assignments?institutionId=nope', owner.token)).status,
      ).toBe(400);
    });

    it('answers 404 for an Institution the caller does not reach', async () => {
      const outsider = await fixtures.institutionAdmin(societyA, [second]);
      expect((await list('', outsider.token)).status).toBe(404);
      const foreign = await fixtures.owner(await makeSociety());
      expect((await list('', foreign.token)).status).toBe(404);
    });
  });

  describe('ASG-03 end an assignment', () => {
    it('ends it, drops it from the list, keeps the row as history, and audits it', async () => {
      const made = await assigned();
      const res = await api(
        'delete',
        `/v1/teaching-assignments/${made.id}`,
        institutionAdmin.token,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      expect(await total('')).toBe(0);
      const rows = await history('teaching_assignments', teacher.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ended_by: institutionAdmin.person });
      expect(rows[0]!.ended_at).not.toBeNull();
      const entry = (await audit(made.id)).find((e) => e.action === 'assignment.ended');
      expect(entry).toMatchObject({
        actor_user_id: institutionAdmin.person,
        institution_id: first,
        entity_type: 'teaching_assignment',
      });
      expect(entry?.old_values).toEqual({
        staffMemberId: teacher.id,
        academicYearId: year,
        sectionId: sectionA,
        subjectId: math,
      });
    });

    it('answers 404 the second time, for an id that is not there, and for one that is not a UUID', async () => {
      const made = await assigned();
      await api('delete', `/v1/teaching-assignments/${made.id}`, owner.token);
      expect((await api('delete', `/v1/teaching-assignments/${made.id}`, owner.token)).status).toBe(
        404,
      );
      expect((await api('delete', `/v1/teaching-assignments/${missing}`, owner.token)).status).toBe(
        404,
      );
      expect((await api('delete', '/v1/teaching-assignments/nope', owner.token)).status).toBe(404);
    });

    it('answers 404 to an Admin of another Institution and to another Society, and 403 to a teacher', async () => {
      const made = await assigned();
      const path = `/v1/teaching-assignments/${made.id}`;
      const outsider = await fixtures.institutionAdmin(societyA, [second]);
      expect((await api('delete', path, outsider.token)).status).toBe(404);
      const foreign = await fixtures.owner(await makeSociety());
      expect((await api('delete', path, foreign.token)).status).toBe(404);
      const teacherToken = await actingAs(teacher.person.email, TEACHER);
      expect((await api('delete', path, teacherToken)).status).toBe(403);
      expect(await total('')).toBe(1);
    });
  });

  describe('STF-05 deactivate ends the assignments', () => {
    it('ends the class teacher row and every teaching assignment of the teacher, and says how many', async () => {
      await lead(teacher.id, sectionA);
      await assigned();
      await assigned({ sectionId: sectionB });
      await assigned({ staffMemberId: other.id });
      expect((await api('delete', `/v1/staff/${teacher.id}`, owner.token)).status).toBe(200);
      expect((await history('class_teacher_assignments', teacher.id))[0]!.ended_at).not.toBeNull();
      expect(
        (await history('teaching_assignments', teacher.id)).every((r) => r.ended_at !== null),
      ).toBe(true);
      const listed = await list('');
      expect(listed.body.meta!.totalItems).toBe(1);
      expect(rowsOf(listed)[0]!.staffMember.id).toBe(other.id);
      const entry = (await audit(teacher.id)).find((e) => e.action === 'staff.deactivated');
      expect(entry?.new_values).toMatchObject({ assignmentsEnded: 3 });
      // Another teacher may now lead the section.
      expect((await lead(other.id, sectionA)).status).toBe(200);
    });
  });

  describe('the tables', () => {
    it('is invisible to another Society', async () => {
      await lead(teacher.id, sectionA);
      await assigned();
      const foreign = await fixtures.owner(await makeSociety());
      const seen = await database.transaction(
        {
          personId: foreign.person,
          roleCode: 2,
          societyId: foreign.contexts[0]!.societyId!,
          institutionIds: [],
        },
        async (tx) => ({
          lead: (await sql`select id from class_teacher_assignments`.execute(tx)).rows,
          teaching: (await sql`select id from teaching_assignments`.execute(tx)).rows,
        }),
      );
      expect(seen).toEqual({ lead: [], teaching: [] });
    });

    it('is invisible to an Admin of another Institution of the Society', async () => {
      await assigned();
      const seen = await database.transaction(
        { personId: owner.person, roleCode: 3, societyId: societyA, institutionIds: [second] },
        async (tx) => (await sql`select id from teaching_assignments`.execute(tx)).rows,
      );
      expect(seen).toEqual([]);
    });

    it('lets the app change only ended_at and ended_by, and never delete', async () => {
      const made = await assigned();
      await expect(
        database.transaction(tenantA(), (tx) =>
          sql`update teaching_assignments set subject_id = subject_id, section_id = ${sectionB} where id = ${made.id}`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.transaction(tenantA(), (tx) =>
          sql`delete from teaching_assignments where id = ${made.id}`.execute(tx),
        ),
      ).rejects.toThrow(/permission denied/);
      await lead(teacher.id, sectionA);
      await expect(
        database.transaction(tenantA(), (tx) =>
          sql`delete from class_teacher_assignments where staff_member_id = ${teacher.id}`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('holds one active class-teacher row per teacher and year, and ended and by go together', async () => {
      await lead(teacher.id, sectionA);
      const insert = (section: string) =>
        database.transaction(tenantA(), (tx) =>
          sql`insert into class_teacher_assignments
            (created_by, society_id, institution_id, academic_year_id, section_id, staff_member_id)
            values (${owner.person}, ${societyA}, ${first}, ${year}, ${section}, ${teacher.id})`.execute(
            tx,
          ),
        );
      await expect(insert(sectionB)).rejects.toThrow(/uq_class_teacher_staff/);
      await expect(
        database.transaction(tenantA(), (tx) =>
          sql`update class_teacher_assignments set ended_at = now() where staff_member_id = ${teacher.id}`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/ck_class_teacher_assignments_ended/);
    });

    it('keys the teacher to the Institution the row is in: their home only', async () => {
      const extra = await api('put', `/v1/staff/${teacher.id}/institutions`, owner.token, {
        institutionIds: [second],
      });
      expect(extra.status).toBe(200);
      const secondSection = await sectionOfSecond();
      const secondYear = await makeYear(second);
      await expect(
        database.transaction({ ...tenantA(), institutionIds: [second] }, (tx) =>
          sql`insert into class_teacher_assignments
              (created_by, society_id, institution_id, academic_year_id, section_id, staff_member_id)
              values (${owner.person}, ${societyA}, ${second}, ${secondYear}, ${secondSection}, ${teacher.id})`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/fk_class_teacher_assignments_staff/);
    });
  });
});
