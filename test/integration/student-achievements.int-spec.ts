import { Kysely, PostgresDialect, sql } from 'kysely';
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

interface StarBody {
  id: string;
  studentId: string;
  academicYearId: string;
  tier: number;
  description: string;
  awardedByStaffMemberId: string | null;
  createdBy: { id: string | null; displayName: string };
  createdAt: string;
}
interface TabBody {
  stars: { total: number; silver: number; gold: number; platinum: number };
  achievements: StarBody[];
}

/** ACH-01 to ACH-03 (API design 9.6, PRD 7.6): the stars of a student. */
describe('a student’s achievements', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;
  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let societyId: string;
  let first: string;
  let second: string;
  let year: string;
  let nineA: StudentPlace;
  let nineB: StudentPlace;
  let abroadPlace: StudentPlace;
  let meera: SchoolStaff;
  let dev: SchoolStaff;
  let diya: SchoolStudent;
  let ravi: SchoolStudent;

  const admit = (place: StudentPlace, institutionId = first) =>
    kit.student(owner.token, institutionId, place);
  const asTeacher = (staff: SchoolStaff) => kit.actingAs(staff.person.email, TEACHER, societyId);
  const tab = async (student: SchoolStudent, token = owner.token, query = '') => {
    const res = await api('get', `/v1/students/${student.id}/achievements${query}`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as TabBody;
  };
  const give = (student: SchoolStudent, body: object, token = owner.token) =>
    api('post', `/v1/students/${student.id}/achievements`, token, body);
  const star = { tier: 2, description: 'Won the inter-school quiz' };
  const remove = (id: string, token = owner.token) =>
    api('delete', `/v1/achievements/${id}`, token);
  const tenant = (institutionIds: string[]) => ({
    personId: owner.person,
    roleCode: 2,
    societyId,
    institutionIds,
  });
  const read = <T>(
    work: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<T>,
    institutionIds = [first, second],
  ) => database.transaction(tenant(institutionIds), work);
  const stored = (id: string) =>
    read(
      async (tx) =>
        (
          await sql<{
            status: number;
            updated_by: string | null;
            student_enrolment_id: string;
            academic_year_id: string;
          }>`select status, updated_by, student_enrolment_id, academic_year_id
            from student_achievements where id = ${id}`.execute(tx)
        ).rows[0]!,
    );
  const insert = (fields: Record<string, unknown>, institutionIds = [first]) =>
    read(async (tx) => {
      const enrolment = (
        await sql<{ id: string }>`select e.id from student_enrolments e
          where e.student_id = ${diya.id}`.execute(tx)
      ).rows[0]!.id;
      const values = {
        society: societyId,
        institution: first,
        year,
        enrolment,
        tier: 1,
        description: 'Quiz',
        staff: null,
        ...fields,
      };
      await sql`insert into student_achievements (society_id, institution_id, academic_year_id,
          student_enrolment_id, tier, description, awarded_by_staff_member_id)
        values (${values.society}, ${values.institution}, ${values.year}, ${values.enrolment},
          ${values.tier}, ${values.description}, ${values.staff})`.execute(tx);
    }, institutionIds);
  const seen = (institutionIds: string[]) =>
    read(
      async (tx) =>
        (await tx.selectFrom('student_achievements').select('id').execute()).map((r) => r.id),
      institutionIds,
    );
  const audit = async (entityId: string) =>
    (
      await readAuditRows<{
        action: string;
        entity_type: string;
        institution_id: string | null;
        old_values: unknown;
        new_values: unknown;
      }>(ownerDb, sql`entity_id = ${entityId}`)
    ).map((e) => ({
      action: e.action,
      entityType: e.entity_type,
      institutionId: e.institution_id,
      before: e.old_values,
      after: e.new_values,
    }));

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
    const categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    const classes = await kit.masters(admin, 'predefined-classes');
    const sectionCodes = await kit.masters(admin, 'predefined-sections');
    societyId = await kit.society(admin);
    owner = await fixtures.owner(societyId);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    institutionAdmin = await fixtures.institutionAdmin(societyId, [first]);
    year = await kit.year(owner.token, first);
    const class9 = await kit.klass(owner.token, first, classes.find((c) => c.code === 'C09')!.id);
    const sectionA = await kit.section(
      owner.token,
      class9,
      sectionCodes.find((s) => s.code === 'A')!.id,
    );
    const sectionB = await kit.section(
      owner.token,
      class9,
      sectionCodes.find((s) => s.code === 'B')!.id,
    );
    nineA = { academicYearId: year, classId: class9, sectionId: sectionA };
    nineB = { academicYearId: year, classId: class9, sectionId: sectionB };
    const otherYear = await kit.year(owner.token, second);
    const otherClass = await kit.klass(
      owner.token,
      second,
      classes.find((c) => c.code === 'C09')!.id,
    );
    abroadPlace = {
      academicYearId: otherYear,
      classId: otherClass,
      sectionId: await kit.section(
        owner.token,
        otherClass,
        sectionCodes.find((s) => s.code === 'A')!.id,
      ),
    };
    meera = await kit.staff(owner.token, first, categoryId, { firstName: 'Meera' });
    dev = await kit.staff(owner.token, first, categoryId, { firstName: 'Dev' });
    succeeded(
      await api('put', `/v1/staff/${meera.id}/class-teacher`, owner.token, {
        academicYearId: year,
        sectionId: sectionA,
      }),
      200,
      'Meera leads 9A',
    );
    diya = await admit(nineA);
    ravi = await admit(nineB);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('ACH-02 give a star, ACH-01 the tab', () => {
    it('gives a star to the student’s enrolment for the year, shows who and when, and audits it', async () => {
      const res = await give(diya, star);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        studentId: diya.id,
        academicYearId: year,
        tier: 2,
        description: 'Won the inter-school quiz',
        awardedByStaffMemberId: null,
        createdBy: { id: owner.person },
      });
      expect(typeof res.body.data.createdAt).toBe('string');
      const id = res.body.data.id;
      expect(await stored(id)).toMatchObject({ status: 1, academic_year_id: year });
      expect(await audit(id)).toContainEqual(
        expect.objectContaining({
          action: 'achievement.created',
          entityType: 'student_achievement',
          institutionId: first,
          after: { studentId: diya.id, academicYearId: year, tier: 2 },
        }),
      );
      expect((await tab(diya)).achievements.map((a) => a.id)).toEqual([id]);
      expect((await tab(ravi)).achievements).toEqual([]);
    });

    it('counts the stars earned by tier and lists the newest first', async () => {
      const bodies = [
        { tier: 1, description: 'Silver one' },
        { tier: 3, description: 'Platinum' },
        { tier: 1, description: 'Silver two' },
      ];
      const ids: string[] = [];
      for (const body of bodies) ids.push((await give(diya, body)).body.data.id as string);
      const shown = await tab(diya);
      expect(shown.stars).toEqual({ total: 3, silver: 2, gold: 0, platinum: 1 });
      expect(shown.achievements.map((a) => a.id)).toEqual(ids.toReversed());
      expect(await tab(ravi)).toEqual({
        stars: { total: 0, silver: 0, gold: 0, platinum: 0 },
        achievements: [],
      });
    });

    it('keeps one year’s stars apart when a year is asked for', async () => {
      await give(diya, star);
      expect((await tab(diya, owner.token, `?academicYearId=${year}`)).stars.total).toBe(1);
      expect(
        (await tab(diya, owner.token, '?academicYearId=0192f3b0-0000-7000-8000-000000000001')).stars
          .total,
      ).toBe(0);
      expect(
        (await api('get', `/v1/students/${diya.id}/achievements?academicYearId=x`, owner.token))
          .status,
      ).toBe(400);
    });

    it('lets an Admin give one, and ties a teacher’s star to their staff record', async () => {
      expect((await give(diya, star, institutionAdmin.token)).status).toBe(201);
      const res = await give(
        diya,
        { tier: 1, description: 'Helped a classmate' },
        await asTeacher(meera),
      );
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        awardedByStaffMemberId: meera.id,
        createdBy: { id: meera.person.id },
      });
      expect((await tab(diya)).stars.total).toBe(2);
    });

    it('lets a teacher read and give only for the students of their own sections', async () => {
      const token = await asTeacher(meera);
      expect((await tab(diya, token)).stars.total).toBe(0);
      const other = await give(ravi, star, token);
      expect([other.status, other.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      const read9b = await api('get', `/v1/students/${ravi.id}/achievements`, token);
      expect([read9b.status, read9b.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      const nobody = await asTeacher(dev);
      expect((await give(diya, star, nobody)).status).toBe(403);
      expect((await api('get', `/v1/students/${diya.id}/achievements`, nobody)).status).toBe(403);
      expect((await tab(ravi)).stars.total).toBe(0);
    });

    it('checks the body: the tier, the description and no other field', async () => {
      for (const body of [
        { description: 'Quiz' },
        { tier: 0, description: 'Quiz' },
        { tier: 4, description: 'Quiz' },
        { tier: '2', description: 'Quiz' },
        { tier: 1 },
        { tier: 1, description: '' },
        { tier: 1, description: '   ' },
        { tier: 1, description: 'x'.repeat(501) },
      ]) {
        expect((await give(diya, body)).status).toBe(400);
      }
      const extra = await give(diya, { ...star, studentId: ravi.id });
      expect([extra.status, extra.body.errors?.[0]?.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      expect((await give(diya, { tier: 1, description: 'x'.repeat(500) })).status).toBe(201);
      expect((await tab(diya)).stars.total).toBe(1);
    });

    it('is 404 for a deactivated student, who keeps the stars for the admins who read them', async () => {
      const made = await give(diya, star);
      await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token);
      expect((await give(diya, star)).status).toBe(404);
      expect((await tab(diya)).achievements.map((a) => a.id)).toEqual([made.body.data.id]);
      expect((await give(diya, star, await asTeacher(meera))).status).toBe(404);
    });

    it('is for the Owner, the Admins and the teachers of the child’s Institution, and no Super Admin or stranger', async () => {
      const abroad = await admit(abroadPlace, second);
      expect((await give(abroad, star, institutionAdmin.token)).status).toBe(404);
      expect(
        (await api('get', `/v1/students/${abroad.id}/achievements`, institutionAdmin.token)).status,
      ).toBe(404);
      expect((await give(diya, star, admin)).status).toBe(403);
      expect((await api('get', `/v1/students/${diya.id}/achievements`, admin)).status).toBe(403);
      const otherOwner = await fixtures.owner(await kit.society(admin));
      expect((await give(diya, star, otherOwner.token)).status).toBe(404);
      expect((await api('get', '/v1/students/not-a-uuid/achievements', owner.token)).status).toBe(
        404,
      );
      expect((await give(abroad, star)).status).toBe(201);
    });
  });

  describe('ACH-03 remove a star', () => {
    it('removes it: it leaves the tab and the count, nothing is deleted, and a second call is 404', async () => {
      const made = await give(diya, star);
      const id = made.body.data.id as string;
      const res = await remove(id);
      expect([res.status, res.body.data]).toEqual([200, { id, status: 0 }]);
      expect(await tab(diya)).toEqual({
        stars: { total: 0, silver: 0, gold: 0, platinum: 0 },
        achievements: [],
      });
      expect(await stored(id)).toMatchObject({ status: 0, updated_by: owner.person });
      expect((await remove(id)).status).toBe(404);
      expect(await audit(id)).toContainEqual(
        expect.objectContaining({
          action: 'achievement.removed',
          entityType: 'student_achievement',
          institutionId: first,
          before: { studentId: diya.id, tier: 2, status: 1 },
          after: { status: 0 },
        }),
      );
    });

    it('lets a teacher remove a star they gave, and not one another gave', async () => {
      const token = await asTeacher(meera);
      const mine = await give(diya, star, token);
      const theirs = await give(diya, star);
      const refused = await remove(theirs.body.data.id, token);
      expect(refused.status).toBe(403);
      expect((await stored(theirs.body.data.id)).status).toBe(1);
      expect((await remove(mine.body.data.id, token)).status).toBe(200);
      expect((await tab(diya)).stars.total).toBe(1);
      expect((await remove(theirs.body.data.id, institutionAdmin.token)).status).toBe(200);
      expect((await remove(mine.body.data.id, await asTeacher(dev))).status).toBe(404);
    });

    it('is 404 for a star that is not there, one at an Institution the caller does not reach, and a stranger’s', async () => {
      expect((await remove('0192f3b0-0000-7000-8000-000000000001')).status).toBe(404);
      expect((await remove('not-a-uuid')).status).toBe(404);
      const abroad = await admit(abroadPlace, second);
      const theirs = await give(abroad, star);
      expect((await remove(theirs.body.data.id, institutionAdmin.token)).status).toBe(404);
      expect((await remove(theirs.body.data.id, admin)).status).toBe(403);
      const otherOwner = await fixtures.owner(await kit.society(admin));
      expect((await remove(theirs.body.data.id, otherOwner.token)).status).toBe(404);
      expect((await stored(theirs.body.data.id)).status).toBe(1);
    });
  });

  describe('the rules the database keeps itself', () => {
    it.each([
      ['a tier of 0', { tier: 0 }, 'ck_student_achievements_tier'],
      ['a tier of 4', { tier: 4 }, 'ck_student_achievements_tier'],
      ['a blank description', { description: '  ' }, 'ck_student_achievements_description'],
    ])('refuses %s', async (_name, fields, constraint) => {
      await expect(insert(fields)).rejects.toMatchObject({ code: '23514', constraint });
    });

    it('keeps a star in its enrolment’s year and Institution, by composite keys', async () => {
      await expect(insert({ year: abroadPlace.academicYearId })).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_student_achievements_enrolment_year',
      });
      await expect(insert({ institution: second }, [first, second])).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_student_achievements_enrolment',
      });
    });

    it('refuses a star for an Institution the session does not reach', async () => {
      await expect(insert({ institution: second })).rejects.toThrow(/row-level security/);
    });

    it('shows a session only the stars of the Institutions it reaches', async () => {
      const abroad = await admit(abroadPlace, second);
      const mine = await give(diya, star);
      const theirs = await give(abroad, star);
      expect(await seen([first])).toEqual([mine.body.data.id]);
      expect(await seen([second])).toEqual([theirs.body.data.id]);
    });

    it('lets the application change only the status of a star, and never delete one', async () => {
      const made = await give(diya, star);
      const id = made.body.data.id as string;
      for (const statement of [
        sql`update student_achievements set tier = 3 where id = ${id}`,
        sql`update student_achievements set description = 'Changed' where id = ${id}`,
        sql`delete from student_achievements where id = ${id}`,
      ]) {
        await expect(read((tx) => statement.execute(tx), [first])).rejects.toMatchObject({
          code: '42501',
        });
      }
    });
  });
});
