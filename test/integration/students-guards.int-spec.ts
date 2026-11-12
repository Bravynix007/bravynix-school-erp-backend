import { Kysely, PostgresDialect, sql } from 'kysely';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import {
  SchoolKit,
  succeeded,
  type SchoolStaff,
  type SchoolStudent,
  type StudentPlace,
} from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;

interface SectionBody {
  id: string;
  currentStudentCount: number;
}

interface ClassroomStudent {
  id: string;
  firstName: string;
  lastName: string | null;
  gender: number | null;
  dateOfBirth: string | null;
  bloodGroup: string | null;
  placement: { sectionId: string; rollNumber: string };
}

const CLASSROOM_KEYS = [
  'bloodGroup',
  'dateOfBirth',
  'firstName',
  'gender',
  'id',
  'institutionId',
  'lastName',
  'photoFileId',
  'placement',
];

/**
 * The student count on a section, `HAS_STUDENTS` on classes and sections, and the teacher's classroom view
 * (API design 6.4 D7, 9.6, 10.4j).
 */
describe('students: the section count, HAS_STUDENTS and the classroom view', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;

  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let societyA: string;
  let first: string;
  let categoryId: string;
  let year: string;
  let class9: string;
  let class10: string;
  let nineA: string;
  let nineB: string;
  let tenA: string;
  // Meera leads 9A; Chitra teaches 9B; Dev has nothing.
  let meera: SchoolStaff;
  let chitra: SchoolStaff;
  let dev: SchoolStaff;
  let math: string;

  const at = (sectionId: string, classId = class9): StudentPlace => ({
    academicYearId: year,
    classId,
    sectionId,
  });
  const admit = (sectionId: string, fields: object = {}, classId = class9) =>
    kit.student(owner.token, first, at(sectionId, classId), fields);
  const roll = (sectionId: string, rollNumber: string, classId = class9) => ({
    enrolment: { ...at(sectionId, classId), rollNumber },
  });
  const sections = async (classId: string, token = owner.token) => {
    const res = await api('get', `/v1/classes/${classId}/sections`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as SectionBody[];
  };
  const countOf = async (classId: string, sectionId: string) =>
    (await sections(classId)).find((s) => s.id === sectionId)!.currentStudentCount;
  const deactivateStudent = (student: SchoolStudent, reason = 1) =>
    api('delete', `/v1/students/${student.id}`, owner.token, { reason });
  const asTeacher = (staff: SchoolStaff) => kit.actingAs(staff.person.email, TEACHER, societyA);
  const classroom = async (token: string, query = '') => {
    const res = await api('get', `/v1/students${query}`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as ClassroomStudent[];
  };

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
    const classes = await kit.masters(admin, 'predefined-classes');
    const sectionCodes = await kit.masters(admin, 'predefined-sections');
    societyA = await kit.society(admin);
    owner = await fixtures.owner(societyA);
    first = await kit.institution(owner.token, categoryId);
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
    year = await kit.year(owner.token, first);
    const classCode = (code: string) => classes.find((c) => c.code === code)!.id;
    const sectionCode = (code: string) => sectionCodes.find((s) => s.code === code)!.id;
    class9 = await kit.klass(owner.token, first, classCode('C09'));
    class10 = await kit.klass(owner.token, first, classCode('C10'));
    nineA = await kit.section(owner.token, class9, sectionCode('A'));
    nineB = await kit.section(owner.token, class9, sectionCode('B'));
    tenA = await kit.section(owner.token, class10, sectionCode('A'));
    math = await kit.subject(owner.token, 'Mathematics');
    meera = await kit.staff(owner.token, first, categoryId, { firstName: 'Meera' });
    chitra = await kit.staff(owner.token, first, categoryId, { firstName: 'Chitra' });
    dev = await kit.staff(owner.token, first, categoryId, { firstName: 'Dev' });
    succeeded(
      await api('put', `/v1/staff/${chitra.id}/subjects`, owner.token, { subjectIds: [math] }),
      200,
      'Chitra teaches maths',
    );
    succeeded(
      await api('put', `/v1/staff/${meera.id}/class-teacher`, owner.token, {
        academicYearId: year,
        sectionId: nineA,
      }),
      200,
      'Meera leads 9A',
    );
    succeeded(
      await api('post', '/v1/teaching-assignments', owner.token, {
        staffMemberId: chitra.id,
        academicYearId: year,
        sectionId: nineB,
        subjectId: math,
      }),
      201,
      'Chitra teaches 9B',
    );
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('SEC-01 the student count', () => {
    it('counts the students in each section, 0 for an empty one, for an Owner and an Admin', async () => {
      await admit(nineA);
      await admit(nineA);
      await admit(nineB);
      for (const token of [owner.token, institutionAdmin.token]) {
        expect((await sections(class9, token)).map((s) => [s.id, s.currentStudentCount])).toEqual([
          [nineA, 2],
          [nineB, 1],
        ]);
      }
      expect(await countOf(class10, tenA)).toBe(0);
    });

    it('follows a move, a deactivation and a student added later', async () => {
      const diya = await admit(nineA);
      await admit(nineA);
      expect(await countOf(class9, nineA)).toBe(2);
      succeeded(
        await api('patch', `/v1/students/${diya.id}/placement`, owner.token, {
          sectionId: nineB,
          rollNumber: '1',
        }),
        200,
        'move',
      );
      expect([await countOf(class9, nineA), await countOf(class9, nineB)]).toEqual([1, 1]);
      succeeded(await deactivateStudent(diya), 200, 'deactivate');
      expect([await countOf(class9, nineA), await countOf(class9, nineB)]).toEqual([1, 0]);
    });

    it('shows a teacher the count of their own sections, and 0 for a section just added', async () => {
      await admit(nineA);
      await admit(nineA);
      expect(
        (await sections(class9, await asTeacher(meera))).map((s) => s.currentStudentCount),
      ).toEqual([2]);
      const created = await api('post', '/v1/sections', owner.token, {
        classId: class10,
        predefinedSectionId: (await kit.masters(admin, 'predefined-sections')).find(
          (s) => s.code === 'B',
        )!.id,
      });
      expect(created.body.data).toMatchObject({ currentStudentCount: 0 });
    });
  });

  describe('HAS_STUDENTS', () => {
    it('refuses to deactivate a section while a student sits in it, and writes nothing', async () => {
      const diya = await admit(nineA);
      const refused = await api('delete', `/v1/sections/${nineA}`, owner.token);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'HAS_STUDENTS' });
      expect((await sections(class9)).map((s) => s.id)).toEqual([nineA, nineB]);
      succeeded(await deactivateStudent(diya), 200, 'deactivate the student');
      succeeded(await api('delete', `/v1/sections/${nineA}`, owner.token), 200, 'deactivate 9A');
    });

    it('lets a section go once its students have moved out', async () => {
      const diya = await admit(nineA);
      succeeded(
        await api('patch', `/v1/students/${diya.id}/placement`, owner.token, { sectionId: nineB }),
        200,
        'move',
      );
      succeeded(await api('delete', `/v1/sections/${nineA}`, owner.token), 200, 'deactivate 9A');
    });

    it('refuses to deactivate a class while a student sits in any of its sections, and keeps its sections', async () => {
      await admit(nineB);
      const refused = await api('delete', `/v1/classes/${class9}`, owner.token);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'HAS_STUDENTS' });
      expect((await sections(class9)).map((s) => s.id)).toEqual([nineA, nineB]);
      // A class with no student goes, with its sections.
      succeeded(await api('delete', `/v1/classes/${class10}`, owner.token), 200, 'deactivate 10th');
    });

    it('lets the class go once its students are deactivated', async () => {
      const diya = await admit(nineA);
      succeeded(await deactivateStudent(diya, 2), 200, 'deactivate the student');
      succeeded(await api('delete', `/v1/classes/${class9}`, owner.token), 200, 'deactivate 9th');
    });

    it('refuses a student in a section that was deactivated, as before', async () => {
      succeeded(await api('delete', `/v1/sections/${nineA}`, owner.token), 200, 'deactivate 9A');
      const res = await api('post', '/v1/students', owner.token, kit.studentBody(first, at(nineA)));
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'INACTIVE_SECTION' });
    });

    it('makes a student wait for a deactivation under way, then refuses the section', async () => {
      // SEC-04 locks the section row first; here the lock is held by hand, and the section is then deactivated.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (locked = resolve));
      const tenant = {
        personId: owner.person,
        roleCode: 2,
        societyId: societyA,
        institutionIds: [first],
      };
      const deactivating = database.transaction(tenant, async (tx) => {
        await sql`select id from sections where id = ${nineA} for update`.execute(tx);
        locked();
        await gate;
        await sql`update sections set status = 0 where id = ${nineA}`.execute(tx);
      });
      await held;
      let settled = false;
      const adding = api(
        'post',
        '/v1/students',
        owner.token,
        kit.studentBody(first, at(nineA)),
      ).then((res) => {
        settled = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(settled).toBe(false);
      release();
      await deactivating;
      const res = await adding;
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'INACTIVE_SECTION' });
    });
  });

  describe('the teacher classroom view (STU-01, STU-03)', () => {
    it('lists the students of the sections the teacher leads or teaches, with the classroom fields only', async () => {
      const diya = await admit(nineA, {
        firstName: 'Diya',
        gender: 2,
        dateOfBirth: '2012-03-04',
        bloodGroup: 'O+',
        admissionNo: 'ADM-17',
        contactEmail: 'diya@family.test',
        ...roll(nineA, '4'),
      });
      await admit(nineB, { firstName: 'Zara', ...roll(nineB, '2') });
      await admit(tenA, { firstName: 'Kabir', ...roll(tenA, '1', class10) }, class10);

      const lead = await api('get', '/v1/students', await asTeacher(meera));
      expect(lead.status).toBe(200);
      const [shown] = lead.body.data as unknown as ClassroomStudent[];
      expect(lead.body.data).toHaveLength(1);
      expect(shown).toMatchObject({
        id: diya.id,
        firstName: 'Diya',
        gender: 2,
        dateOfBirth: '2012-03-04',
        bloodGroup: 'O+',
        placement: { sectionId: nineA, rollNumber: '4' },
      });
      expect(Object.keys(shown!).toSorted()).toEqual(CLASSROOM_KEYS);
      expect((await classroom(await asTeacher(chitra))).map((s) => s.firstName)).toEqual(['Zara']);
      expect(await classroom(await asTeacher(dev))).toEqual([]);
    });

    it('searches and filters inside the teacher’s own sections only', async () => {
      await admit(nineA, { firstName: 'Diya', ...roll(nineA, '4') });
      await admit(nineB, { firstName: 'Dinesh', ...roll(nineB, '2') });
      const token = await asTeacher(meera);
      expect((await classroom(token, '?q=di')).map((s) => s.firstName)).toEqual(['Diya']);
      expect(await classroom(token, `?sectionId=${nineB}`)).toEqual([]);
      expect((await classroom(token, `?sectionId=${nineA}`)).map((s) => s.firstName)).toEqual([
        'Diya',
      ]);
    });

    it('does not show deactivated students, whatever status is asked', async () => {
      const diya = await admit(nineA, { firstName: 'Diya' });
      await admit(nineA, { firstName: 'Asha' });
      succeeded(await deactivateStudent(diya, 3), 200, 'deactivate');
      expect(
        (await classroom(await asTeacher(meera), '?status=0&status=1')).map((s) => s.firstName),
      ).toEqual(['Asha']);
    });

    it('sorts by name or roll number, and refuses another sort with 400', async () => {
      await admit(nineA, { firstName: 'Diya', ...roll(nineA, '4') });
      await admit(nineA, { firstName: 'Asha', ...roll(nineA, '9') });
      const token = await asTeacher(meera);
      expect((await classroom(token, '?sort=-name')).map((s) => s.firstName)).toEqual([
        'Diya',
        'Asha',
      ]);
      expect((await classroom(token, '?sort=rollNumber')).map((s) => s.firstName)).toEqual([
        'Diya',
        'Asha',
      ]);
      expect((await api('get', '/v1/students?sort=admissionNo', token)).status).toBe(400);
    });

    it('opens the profile of a student in an own section as the classroom view', async () => {
      const diya = await admit(nineA, {
        gender: 2,
        dateOfBirth: '2012-03-04',
        bloodGroup: 'O+',
        contactEmail: 'diya@family.test',
      });
      const res = await api('get', `/v1/students/${diya.id}`, await asTeacher(meera));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).toSorted()).toEqual(CLASSROOM_KEYS);
      expect(res.body.data).toMatchObject({ id: diya.id, bloodGroup: 'O+' });
    });

    it('is 403 NOT_ASSIGNED for a student of another section of the school, and for a deactivated one', async () => {
      const zara = await admit(nineB);
      const kabir = await admit(tenA, {}, class10);
      const gone = await admit(nineA);
      succeeded(await deactivateStudent(gone), 200, 'deactivate');
      const token = await asTeacher(meera);
      for (const student of [zara, kabir, gone]) {
        const res = await api('get', `/v1/students/${student.id}`, token);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'NOT_ASSIGNED' });
      }
    });

    it('is 404 for a student of another Society, and for an ID that is nobody’s', async () => {
      const otherOwner = await fixtures.owner(await kit.society(admin));
      const otherInstitution = await kit.institution(otherOwner.token, categoryId);
      const otherYear = await kit.year(otherOwner.token, otherInstitution);
      const classes = await kit.masters(admin, 'predefined-classes');
      const sectionCodes = await kit.masters(admin, 'predefined-sections');
      const otherClass = await kit.klass(
        otherOwner.token,
        otherInstitution,
        classes.find((c) => c.code === 'C09')!.id,
      );
      const otherSection = await kit.section(
        otherOwner.token,
        otherClass,
        sectionCodes.find((s) => s.code === 'A')!.id,
      );
      const stranger = await kit.student(otherOwner.token, otherInstitution, {
        academicYearId: otherYear,
        classId: otherClass,
        sectionId: otherSection,
      });
      const token = await asTeacher(meera);
      expect((await api('get', `/v1/students/${stranger.id}`, token)).status).toBe(404);
      expect(
        (await api('get', '/v1/students/00000000-0000-7000-8000-00000000ffff', token)).status,
      ).toBe(404);
    });

    it('keeps everything else about students closed to a teacher', async () => {
      const diya = await admit(nineA);
      const token = await asTeacher(meera);
      expect(
        (await api('post', '/v1/students', token, kit.studentBody(first, at(nineA)))).status,
      ).toBe(403);
      expect((await api('patch', `/v1/students/${diya.id}`, token, { version: 1 })).status).toBe(
        403,
      );
      expect((await api('delete', `/v1/students/${diya.id}`, token, { reason: 1 })).status).toBe(
        403,
      );
      expect(
        (await api('patch', `/v1/students/${diya.id}/placement`, token, { rollNumber: '9' }))
          .status,
      ).toBe(403);
    });

    it('shows an admin the full list and profile as before', async () => {
      const diya = await admit(nineA, { contactEmail: 'diya@family.test' });
      const list = await api('get', '/v1/students', institutionAdmin.token);
      expect(list.status).toBe(200);
      expect(list.body.data[0]).toMatchObject({ id: diya.id, version: 1 });
      const profile = await api('get', `/v1/students/${diya.id}`, institutionAdmin.token);
      expect(profile.body.data).toMatchObject({ contactEmail: 'diya@family.test' });
      expect(profile.body.data.guardians).toHaveLength(1);
    });
  });
});
