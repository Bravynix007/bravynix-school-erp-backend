import { Kysely, PostgresDialect } from 'kysely';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, succeeded, type SchoolStaff } from '../support/school-kit.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;

interface ClassBody {
  id: string;
  displayName: string;
  sectionCount: number;
}
interface SectionBody {
  id: string;
  displayName: string;
  classTeacher: { staffMemberId: string; firstName: string; lastName: string | null } | null;
}

const names = (rows: { displayName: string }[]) => rows.map((row) => row.displayName);

/** What a teacher reads of the setup (API design 6.4, 10.4h to 10.4j): only their own, with the class teacher shown. */
describe('a teacher reads only their own classes, sections, years and subjects', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;

  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let societyA: string;
  let first: string;
  let second: string;
  let categoryId: string;
  let year: string;
  let class9: string;
  let class10: string;
  let nineA: string;
  let nineB: string;
  let tenA: string;
  let math: string;
  let art: string;
  // Meera leads 9A and teaches maths in 9B; Anil teaches art in 10A; Chitra teaches maths in 9B only; Dev has nothing.
  let meera: SchoolStaff;
  let anil: SchoolStaff;
  let chitra: SchoolStaff;
  let dev: SchoolStaff;

  const added = (firstName: string, homeInstitutionId = first, lastName?: string) =>
    kit.staff(owner.token, homeInstitutionId, categoryId, { firstName, lastName });
  const subjectsOf = (staff: SchoolStaff, subjectIds: string[]) =>
    api('put', `/v1/staff/${staff.id}/subjects`, owner.token, { subjectIds });
  const lead = (staff: SchoolStaff, sectionId: string | null, academicYearId = year) =>
    api('put', `/v1/staff/${staff.id}/class-teacher`, owner.token, { academicYearId, sectionId });
  const teach = (staff: SchoolStaff, sectionId: string, subjectId: string, academicYearId = year) =>
    api('post', '/v1/teaching-assignments', owner.token, {
      staffMemberId: staff.id,
      academicYearId,
      sectionId,
      subjectId,
    });
  const asTeacher = (staff: SchoolStaff) => kit.actingAs(staff.person.email, TEACHER, societyA);

  const classes = async (token: string, institutionId = first) => {
    const res = await api('get', `/v1/classes?institutionId=${institutionId}`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as ClassBody[];
  };
  const sections = (token: string, classId: string) =>
    api('get', `/v1/classes/${classId}/sections`, token);
  const sectionsOf = async (token: string, classId: string) => {
    const res = await sections(token, classId);
    expect(res.status).toBe(200);
    return res.body.data as unknown as SectionBody[];
  };
  const years = async (token: string, institutionId = first) => {
    const res = await api('get', `/v1/academic-years?institutionId=${institutionId}`, token);
    expect(res.status).toBe(200);
    return (res.body.data as unknown as { id: string }[]).map((y) => y.id);
  };
  const subjects = async (token: string) => {
    const res = await api('get', '/v1/subjects', token);
    expect(res.status).toBe(200);
    return (res.body.data as unknown as { id: string }[]).map((s) => s.id);
  };

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
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
    const categories = await kit.masters(admin, 'class-categories');
    categoryId = categories.find((c) => c.code === 'HIGH_SCHOOL')!.id;
    const predefinedClasses = await kit.masters(admin, 'predefined-classes');
    const predefinedSections = await kit.masters(admin, 'predefined-sections');
    societyA = await kit.society(admin);
    owner = await fixtures.owner(societyA);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
    year = await kit.year(owner.token, first);
    const classCode = (code: string) => predefinedClasses.find((c) => c.code === code)!.id;
    const sectionCode = (code: string) => predefinedSections.find((s) => s.code === code)!.id;
    class9 = await kit.klass(owner.token, first, classCode('C09'));
    class10 = await kit.klass(owner.token, first, classCode('C10'));
    nineA = await kit.section(owner.token, class9, sectionCode('A'));
    nineB = await kit.section(owner.token, class9, sectionCode('B'));
    tenA = await kit.section(owner.token, class10, sectionCode('A'));
    math = await kit.subject(owner.token, 'Mathematics');
    art = await kit.subject(owner.token, 'Art');
    await kit.subject(owner.token, 'Music');
    meera = await added('Meera', first, 'Rao');
    anil = await added('Anil');
    chitra = await added('Chitra');
    dev = await added('Dev');
    await subjectsOf(meera, [math]);
    await subjectsOf(anil, [art]);
    await subjectsOf(chitra, [math]);
    succeeded(await lead(meera, nineA), 200, 'Meera leads 9A');
    succeeded(await teach(meera, nineB, math), 201, 'Meera teaches in 9B');
    succeeded(await teach(anil, tenA, art), 201, 'Anil teaches in 10A');
    succeeded(await teach(chitra, nineB, math), 201, 'Chitra teaches in 9B');
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('CLS-01 classes', () => {
    it('shows an Owner and an Admin every class with every section counted', async () => {
      for (const token of [owner.token, institutionAdmin.token]) {
        const all = await classes(token);
        expect(all.map((c) => [c.displayName, c.sectionCount])).toEqual([
          ['9th', 2],
          ['10th', 1],
        ]);
      }
    });

    it('shows a teacher only the classes with a section they lead or teach, counting only those sections', async () => {
      expect((await classes(await asTeacher(meera))).map((c) => [c.id, c.sectionCount])).toEqual([
        [class9, 2],
      ]);
      expect((await classes(await asTeacher(anil))).map((c) => [c.id, c.sectionCount])).toEqual([
        [class10, 1],
      ]);
      // Chitra teaches 9B only, so 9th shows one section for her where the Owner sees two.
      expect((await classes(await asTeacher(chitra))).map((c) => [c.id, c.sectionCount])).toEqual([
        [class9, 1],
      ]);
    });

    it('shows a teacher with no assignment nothing', async () => {
      expect(await classes(await asTeacher(dev))).toEqual([]);
    });

    it('drops a class once the assignment ends, and keeps the class for the Owner', async () => {
      const token = await asTeacher(anil);
      const listed = await api(
        'get',
        `/v1/teaching-assignments?institutionId=${first}`,
        owner.token,
      );
      const mine = (listed.body.data as unknown as { id: string; staffMember: { id: string } }[])
        .filter((row) => row.staffMember.id === anil.id)
        .map((row) => row.id);
      for (const id of mine) {
        expect((await api('delete', `/v1/teaching-assignments/${id}`, owner.token)).status).toBe(
          200,
        );
      }
      expect(await classes(token)).toEqual([]);
      expect(names(await classes(owner.token))).toEqual(['9th', '10th']);
    });

    it('ignores a section that has been deactivated, though its assignment is not ended', async () => {
      const token = await asTeacher(anil);
      expect((await api('delete', `/v1/sections/${tenA}`, owner.token)).status).toBe(200);
      expect(await classes(token)).toEqual([]);
    });

    it('follows the current year: assignments of another year count only once it is current', async () => {
      const next = await kit.year(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      expect((await teach(dev, tenA, art, next)).status).toBe(422);
      expect((await subjectsOf(dev, [art])).status).toBe(200);
      expect((await teach(dev, tenA, art, next)).status).toBe(201);
      const token = await asTeacher(dev);
      expect(await classes(token)).toEqual([]);
      const switched = await api('post', `/v1/academic-years/${next}/make-current`, owner.token, {
        version: 1,
      });
      expect(switched.status).toBe(200);
      expect((await classes(token)).map((c) => c.id)).toEqual([class10]);
      // Meera's assignments belonged to the year that is no longer current.
      expect(await classes(await asTeacher(meera))).toEqual([]);
    });

    it('shows a teacher nothing at an extra Institution: assignments are kept at the home Institution only', async () => {
      const classCodes = await kit.masters(admin, 'predefined-classes');
      await kit.klass(owner.token, second, classCodes.find((c) => c.code === 'C09')!.id);
      expect(
        (
          await api('put', `/v1/staff/${meera.id}/institutions`, owner.token, {
            institutionIds: [second],
          })
        ).status,
      ).toBe(200);
      const token = await asTeacher(meera);
      expect(await classes(token, second)).toEqual([]);
      expect(names(await classes(owner.token, second))).toEqual(['9th']);
    });

    it('still answers 404 for an Institution the teacher does not reach', async () => {
      const token = await asTeacher(meera);
      expect((await api('get', `/v1/classes?institutionId=${second}`, token)).status).toBe(404);
    });
  });

  describe('SEC-01 sections', () => {
    it('shows every section with its class teacher to an Owner and an Admin, null where there is none', async () => {
      for (const token of [owner.token, institutionAdmin.token]) {
        const all = await sectionsOf(token, class9);
        expect(all.map((s) => s.id)).toEqual([nineA, nineB]);
        expect(all[0]!.classTeacher).toEqual({
          staffMemberId: meera.id,
          firstName: 'Meera',
          lastName: 'Rao',
        });
        expect(all[1]!.classTeacher).toBeNull();
      }
    });

    it('shows a teacher only their own sections of the class, and a class teacher where there is one', async () => {
      const own = await sectionsOf(await asTeacher(meera), class9);
      expect(own.map((s) => s.id)).toEqual([nineA, nineB]);
      const chitras = await sectionsOf(await asTeacher(chitra), class9);
      expect(chitras.map((s) => s.id)).toEqual([nineB]);
      expect(chitras[0]!.classTeacher).toBeNull();
    });

    it('answers 403 NOT_ASSIGNED for a class where the teacher has no section, and for any class when they have none', async () => {
      const refused = await sections(await asTeacher(anil), class9);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('NOT_ASSIGNED');
      expect((await sections(await asTeacher(dev), class9)).body.code).toBe('NOT_ASSIGNED');
    });

    it('answers 403 NOT_ASSIGNED for a class of an extra Institution, and 404 for one the teacher does not reach', async () => {
      const classCodes = await kit.masters(admin, 'predefined-classes');
      const otherClass = await kit.klass(
        owner.token,
        second,
        classCodes.find((c) => c.code === 'C09')!.id,
      );
      const token = await asTeacher(meera);
      expect((await sections(token, otherClass)).status).toBe(404);
      await api('put', `/v1/staff/${meera.id}/institutions`, owner.token, {
        institutionIds: [second],
      });
      const asExtra = await sections(await asTeacher(meera), otherClass);
      expect(asExtra.status).toBe(403);
      expect(asExtra.body.code).toBe('NOT_ASSIGNED');
    });

    it('follows STF-09: a new class teacher shows at once, and a stepped-down one is null', async () => {
      expect((await lead(meera, nineB)).status).toBe(200);
      let all = await sectionsOf(owner.token, class9);
      expect(all.map((s) => s.classTeacher?.firstName ?? null)).toEqual([null, 'Meera']);
      expect((await lead(meera, null)).status).toBe(200);
      all = await sectionsOf(owner.token, class9);
      expect(all.map((s) => s.classTeacher)).toEqual([null, null]);
    });

    it('shows the class teacher of the current year only', async () => {
      const next = await kit.year(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      expect((await lead(anil, nineB, next)).status).toBe(200);
      expect(
        (await sectionsOf(owner.token, class9)).map((s) => s.classTeacher?.firstName ?? null),
      ).toEqual(['Meera', null]);
      expect(
        (await api('post', `/v1/academic-years/${next}/make-current`, owner.token, { version: 1 }))
          .status,
      ).toBe(200);
      expect(
        (await sectionsOf(owner.token, class9)).map((s) => s.classTeacher?.firstName ?? null),
      ).toEqual([null, 'Anil']);
    });

    it('drops a class teacher who steps down from their own listing but keeps the sections they teach', async () => {
      const token = await asTeacher(meera);
      expect((await lead(meera, null)).status).toBe(200);
      // Meera still teaches maths in 9B, so 9th stays with that one section and 9A is no longer hers.
      expect((await classes(token)).map((c) => [c.id, c.sectionCount])).toEqual([[class9, 1]]);
      expect((await sectionsOf(token, class9)).map((s) => s.id)).toEqual([nineB]);
    });

    it('shows the class teacher on the section SEC-03 returns', async () => {
      const saved = await api('patch', `/v1/sections/${nineA}`, owner.token, {
        version: 1,
        capacity: 35,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.data.classTeacher).toEqual({
        staffMemberId: meera.id,
        firstName: 'Meera',
        lastName: 'Rao',
      });
    });

    it('shows no class teacher on a section just made', async () => {
      const predefined = await kit.masters(admin, 'predefined-sections');
      const res = await api('post', '/v1/sections', owner.token, {
        classId: class10,
        predefinedSectionId: predefined.find((s) => s.code === 'C')!.id,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.classTeacher).toBeNull();
    });
  });

  describe('AY-01 years', () => {
    it('shows an Owner and an Admin every year, and a teacher only the years in which they hold an assignment', async () => {
      const next = await kit.year(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      expect((await years(owner.token)).toSorted()).toEqual([year, next].toSorted());
      expect((await years(institutionAdmin.token)).toSorted()).toEqual([year, next].toSorted());
      expect(await years(await asTeacher(meera))).toEqual([year]);
      expect(await years(await asTeacher(dev))).toEqual([]);
      expect((await subjectsOf(dev, [art])).status).toBe(200);
      expect((await teach(dev, tenA, art, next)).status).toBe(201);
      expect(await years(await asTeacher(dev))).toEqual([next]);
    });

    it('drops the year of a teacher whose only assignment has ended', async () => {
      const token = await asTeacher(anil);
      expect(await years(token)).toEqual([year]);
      const listed = await api(
        'get',
        `/v1/teaching-assignments?institutionId=${first}`,
        owner.token,
      );
      const mine = (listed.body.data as unknown as { id: string; staffMember: { id: string } }[])
        .filter((row) => row.staffMember.id === anil.id)
        .map((row) => row.id);
      expect(mine).toHaveLength(1);
      expect((await api('delete', `/v1/teaching-assignments/${mine[0]}`, owner.token)).status).toBe(
        200,
      );
      expect(await years(token)).toEqual([]);
    });

    it('drops the year of a class teacher who steps down and teaches nothing', async () => {
      const token = await asTeacher(dev);
      expect((await lead(dev, tenA)).status).toBe(200);
      expect(await years(token)).toEqual([year]);
      expect((await lead(dev, null)).status).toBe(200);
      expect(await years(token)).toEqual([]);
    });

    it('shows a teacher no year at an extra Institution', async () => {
      await kit.year(owner.token, second);
      await api('put', `/v1/staff/${meera.id}/institutions`, owner.token, {
        institutionIds: [second],
      });
      expect(await years(await asTeacher(meera), second)).toEqual([]);
    });
  });

  describe('SUB-01 subjects', () => {
    it('shows an Owner and an Admin every subject, and a teacher only the subjects they can teach', async () => {
      expect(await subjects(owner.token)).toHaveLength(3);
      expect(await subjects(institutionAdmin.token)).toHaveLength(3);
      expect(await subjects(await asTeacher(meera))).toEqual([math]);
      expect(await subjects(await asTeacher(anil))).toEqual([art]);
      expect(await subjects(await asTeacher(dev))).toEqual([]);
      expect((await subjectsOf(dev, [art, math])).status).toBe(200);
      expect((await subjects(await asTeacher(dev))).toSorted()).toEqual([art, math].toSorted());
    });
  });

  describe('a teacher whose home Institution is deactivated (q2)', () => {
    it('loses the teacher context even when an extra Institution is still active: the record is dormant until the Owner adds the person again', async () => {
      expect(
        (
          await api('put', `/v1/staff/${dev.id}/institutions`, owner.token, {
            institutionIds: [second],
          })
        ).status,
      ).toBe(200);
      const before = await signInMobile(t, dev.person.email);
      expect(before.contexts.map((c) => c.roleCode)).toContain(TEACHER);
      const closed = await api('delete', `/v1/institutions/${first}`, owner.token);
      expect(closed.status).toBe(200);
      const after = await signInMobile(t, dev.person.email);
      expect(after.contexts.map((c) => c.roleCode)).not.toContain(TEACHER);
    });
  });
});
