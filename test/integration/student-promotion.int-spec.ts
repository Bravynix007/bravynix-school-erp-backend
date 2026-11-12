import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import {
  down,
  up,
} from '../../src/platform/database/migrations/2026_11_12_0037_people_student_completed_reason.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, type SchoolStudent, type StudentPlace } from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;

const target = (to: StudentPlace) => ({
  toAcademicYearId: to.academicYearId,
  toClassId: to.classId,
  toSectionId: to.sectionId,
});

/** STU-09 and PRM-01 (API design 10.7, PRD 7.6): students move to the next academic year. */
describe('promotion', () => {
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
  let year1: string;
  let year2: string;
  let class9: string;
  let class10: string;
  let nineA: StudentPlace;
  let nineB: StudentPlace;
  let tenA: StudentPlace;
  let tenAYear1: StudentPlace;
  let abroadPlace: StudentPlace;
  let diya: SchoolStudent;
  let ravi: SchoolStudent;
  let tara: SchoolStudent;

  const admit = (at: StudentPlace, rollNumber: string, institutionId = first) =>
    kit.student(owner.token, institutionId, at, {
      enrolment: { ...at, rollNumber },
    });
  const nobody = { toAcademicYearId: null, toClassId: null, toSectionId: null };
  const promote = (body: object, key: string | null = randomUUID(), token = owner.token) => {
    let req = request(t.app.getHttpServer())
      .post('/v1/promotions')
      .set('Authorization', `Bearer ${token}`);
    if (key !== null) req = req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const fromNineA = (fields: object = {}) => ({
    institutionId: first,
    fromAcademicYearId: year1,
    fromClassId: class9,
    fromSectionId: nineA.sectionId,
    ...target(tenA),
    ...fields,
  });
  const promoteOne = (student: SchoolStudent, body: object, token = owner.token) =>
    api('post', `/v1/students/${student.id}/promote`, token, body);
  const profile = async (student: SchoolStudent, token = owner.token) =>
    (await api('get', `/v1/students/${student.id}`, token)).body.data as unknown as {
      placement: { academicYearId: string; classId: string; sectionId: string; rollNumber: string };
    };

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
  /**
   * Holds the student's row as a change to them does, starts `send` so that it waits for it, runs `change` in the
   * holding transaction and commits; the call then runs on what the change left.
   */
  const racing = async <T>(
    student: SchoolStudent,
    send: () => PromiseLike<T>,
    change: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<void>,
  ): Promise<T> => {
    let waiting: Promise<T> | undefined;
    let settled = false;
    await database.transaction(tenant([first]), async (tx) => {
      await sql`select id from students where id = ${student.id} for update`.execute(tx);
      waiting = Promise.resolve(send());
      void waiting.then(() => {
        settled = true;
        return true;
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(settled).toBe(false);
      await change(tx);
    });
    return waiting!;
  };

  /** Every enrolment of the student with its placements, oldest year first. */
  const history = (student: SchoolStudent) =>
    read(
      async (tx) =>
        (
          await sql<{
            year: string;
            class_id: string;
            outcome: number | null;
            status: number;
            enrolled_date: string;
            section_id: string;
            roll_number: string;
            start_date: string;
            end_date: string | null;
            updated_by: string | null;
          }>`select e.academic_year_id as year, e.class_id, e.outcome, e.status,
            to_char(e.enrolled_date, 'YYYY-MM-DD') as enrolled_date, p.section_id, p.roll_number,
            to_char(p.start_date, 'YYYY-MM-DD') as start_date,
            to_char(p.end_date, 'YYYY-MM-DD') as end_date, p.updated_by
          from student_enrolments e join student_section_placements p on p.student_enrolment_id = e.id
          where e.student_id = ${student.id} order by p.start_date`.execute(tx)
        ).rows,
    );
  /** Whether the student is deactivated, and why (`inactive_reason`). */
  const standing = (student: SchoolStudent) =>
    read(
      async (tx) =>
        (
          await sql<{
            status: number;
            inactive_reason: number | null;
          }>`select status, inactive_reason
            from students where id = ${student.id}`.execute(tx)
        ).rows[0],
    );
  const counts = async (classId: string) =>
    Object.fromEntries(
      (
        (await api('get', `/v1/classes/${classId}/sections`, owner.token)).body.data as unknown as {
          id: string;
          currentStudentCount: number;
        }[]
      ).map((s) => [s.id, s.currentStudentCount]),
    );
  const audits = async (where = sql`action = 'student.promoted'`) =>
    (
      await readAuditRows<{
        action: string;
        entity_id: string | null;
        institution_id: string | null;
        new_values: Record<string, unknown>;
      }>(ownerDb, sql`${where} and institution_id = ${first}`)
    ).map((e) => ({ entityId: e.entity_id, after: e.new_values }));

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
    const sectionOf = (code: string) => sectionCodes.find((s) => s.code === code)!.id;
    societyId = await kit.society(admin);
    owner = await fixtures.owner(societyId);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    institutionAdmin = await fixtures.institutionAdmin(societyId, [first]);
    year1 = await kit.year(owner.token, first);
    year2 = await kit.year(owner.token, first, {
      name: '2027-2028',
      startDate: '2027-06-01',
      endDate: '2028-03-31',
    });
    class9 = await kit.klass(owner.token, first, classes.find((c) => c.code === 'C09')!.id);
    class10 = await kit.klass(owner.token, first, classes.find((c) => c.code === 'C10')!.id);
    const sectionA = await kit.section(owner.token, class9, sectionOf('A'));
    const sectionB = await kit.section(owner.token, class9, sectionOf('B'));
    const tenSection = await kit.section(owner.token, class10, sectionOf('A'));
    nineA = { academicYearId: year1, classId: class9, sectionId: sectionA };
    nineB = { academicYearId: year1, classId: class9, sectionId: sectionB };
    tenAYear1 = { academicYearId: year1, classId: class10, sectionId: tenSection };
    tenA = { academicYearId: year2, classId: class10, sectionId: tenSection };
    const otherYear = await kit.year(owner.token, second);
    const otherClass = await kit.klass(
      owner.token,
      second,
      classes.find((c) => c.code === 'C09')!.id,
    );
    abroadPlace = {
      academicYearId: otherYear,
      classId: otherClass,
      sectionId: await kit.section(owner.token, otherClass, sectionOf('A')),
    };
    diya = await admit(nineA, '1');
    ravi = await admit(nineA, '2');
    tara = await admit(nineB, '1');
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('PRM-01 promote a class or section', () => {
    it('ends the old enrolments as Promoted, closes the old placements on the old year’s last day and begins the new ones', async () => {
      const res = await promote(fromNineA());
      expect([res.status, res.body.code]).toEqual([200, 'PROMOTED']);
      expect(res.body.data).toEqual({ promotedCount: 2, skipped: [] });
      expect(res.body.message).toMatch(/^2 students promoted to .+/);
      expect(await history(diya)).toMatchObject([
        {
          year: year1,
          class_id: class9,
          outcome: 1,
          status: 1,
          section_id: nineA.sectionId,
          roll_number: '1',
          end_date: '2027-03-31',
          updated_by: owner.person,
        },
        {
          year: year2,
          class_id: class10,
          outcome: null,
          enrolled_date: '2027-06-01',
          section_id: tenA.sectionId,
          roll_number: '1',
          start_date: '2027-06-01',
          end_date: null,
        },
      ]);
      expect((await profile(diya)).placement).toMatchObject({
        academicYearId: year2,
        classId: class10,
        sectionId: tenA.sectionId,
        rollNumber: '1',
      });
      expect((await profile(tara)).placement.sectionId).toBe(nineB.sectionId);
    });

    it('moves the students out of the old section and into the new one in the counts, and audits once', async () => {
      await promote(fromNineA());
      expect(await counts(class9)).toEqual({ [nineA.sectionId]: 0, [nineB.sectionId]: 1 });
      expect(await counts(class10)).toEqual({ [tenA.sectionId]: 2 });
      expect(await audits()).toEqual([
        {
          entityId: null,
          after: expect.objectContaining({
            fromAcademicYearId: year1,
            toAcademicYearId: year2,
            toClassId: class10,
            toSectionId: tenA.sectionId,
            outcome: 1,
            promotedCount: 2,
            skippedCount: 0,
          }),
        },
      ]);
    });

    it('answers the same call again from the store, and runs nothing twice', async () => {
      const key = randomUUID();
      const one = await promote(fromNineA(), key);
      const again = await promote(fromNineA(), key);
      expect(again.status).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.data).toEqual(one.body.data);
      expect(await audits()).toHaveLength(1);
      const reused = await promote(fromNineA({ studentIds: [diya.id] }), key);
      expect([reused.status, reused.body.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    });

    it('needs an Idempotency-Key', async () => {
      const res = await promote(fromNineA(), null);
      expect([res.status, res.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      expect((await history(diya)).length).toBe(1);
    });

    it('promotes nobody on a second call with a new key, because the placements are closed', async () => {
      await promote(fromNineA());
      const again = await promote(fromNineA());
      expect([again.status, again.body.data]).toEqual([200, { promotedCount: 0, skipped: [] }]);
      expect((await history(diya)).length).toBe(2);
    });

    it('promotes a subset, and skips a student who is not placed there', async () => {
      const res = await promote(fromNineA({ studentIds: [diya.id, tara.id] }));
      expect(res.body.data).toEqual({
        promotedCount: 1,
        skipped: [{ studentId: tara.id, reason: 'NOT_IN_SOURCE' }],
      });
      expect((await profile(diya)).placement.academicYearId).toBe(year2);
      expect((await profile(ravi)).placement.academicYearId).toBe(year1);
    });

    it('leaves out a deactivated student', async () => {
      await api('delete', `/v1/students/${ravi.id}?reason=1`, owner.token);
      const res = await promote(fromNineA());
      expect(res.body.data).toEqual({ promotedCount: 1, skipped: [] });
    });

    it('records Repeating when the target is the same class', async () => {
      const again = { ...nineA, academicYearId: year2 };
      const res = await promote(fromNineA({ ...target(again) }));
      expect(res.body.data).toEqual({ promotedCount: 2, skipped: [] });
      expect((await history(diya))[0]).toMatchObject({ outcome: 2 });
    });

    it('promotes every section of the class: two students who keep one roll number are 409 with the student, and nothing changes', async () => {
      const res = await promote(fromNineA({ fromSectionId: null }));
      expect([res.status, res.body.code]).toEqual([409, 'ROLL_NUMBER_TAKEN']);
      expect(res.body.data).toMatchObject({ studentId: expect.any(String) });
      for (const student of [diya, ravi, tara]) {
        expect((await history(student)).length).toBe(1);
        expect((await history(student))[0]).toMatchObject({ outcome: null, end_date: null });
      }
    });

    it('numbers the students again when asked not to keep the roll numbers', async () => {
      const res = await promote(fromNineA({ fromSectionId: null, keepRollNumbers: false }));
      expect(res.body.data.promotedCount).toBe(3);
      const rolls = await Promise.all(
        [diya, ravi, tara].map(async (s) => (await profile(s)).placement.rollNumber),
      );
      expect(rolls.toSorted()).toEqual(['1', '2', '3']);
    });

    it('completes the final class: the old enrolment is Completed, and nothing begins', async () => {
      const grad = await admit(tenAYear1, '7');
      const res = await promote({
        institutionId: first,
        fromAcademicYearId: year1,
        fromClassId: class10,
        fromSectionId: null,
        ...nobody,
      });
      expect(res.body.message).toBe('1 student completed the final class');
      expect(res.body.data).toEqual({ promotedCount: 1, skipped: [] });
      expect(await history(grad)).toMatchObject([
        { class_id: class10, outcome: 4, end_date: '2027-03-31' },
      ]);
      expect(await counts(class10)).toEqual({ [tenAYear1.sectionId]: 0 });
    });

    it('deactivates the students who complete the final class, as Completed, and nobody else', async () => {
      const grad = await admit(tenAYear1, '7');
      await promote({
        institutionId: first,
        fromAcademicYearId: year1,
        fromClassId: class10,
        fromSectionId: null,
        ...nobody,
      });
      expect(await standing(grad)).toEqual({ status: 0, inactive_reason: 4 });
      expect((await api('get', `/v1/students/${grad.id}`, owner.token)).body.data).toMatchObject({
        status: 0,
      });
      const listed = (await api('get', `/v1/students?institutionId=${first}`, owner.token)).body
        .data as unknown as { id: string }[];
      expect(listed.map((s) => s.id)).not.toContain(grad.id);
      expect(await audits(sql`action = 'student.deactivated'`)).toEqual([
        { entityId: grad.id, after: { status: 0, inactiveReason: 4 } },
      ]);
      // A student who moves on to the next year stays active.
      await promote(fromNineA());
      expect(await standing(diya)).toEqual({ status: 1, inactive_reason: null });
    });

    it('runs the migration down with a completed student on file: reason 3 replaces 4, and up brings the check back', async () => {
      const grad = await admit(tenAYear1, '7');
      await promote({
        institutionId: first,
        fromAcademicYearId: year1,
        fromClassId: class10,
        fromSectionId: null,
        ...nobody,
      });
      await ownerDb.transaction().execute(async (tx) => {
        await down(tx);
        await up(tx);
      });
      expect(await standing(grad)).toEqual({ status: 0, inactive_reason: 3 });
      // Up brought the check back: 4 is allowed again, 5 is not.
      await read((tx) =>
        sql`update students set inactive_reason = 4 where id = ${grad.id}`.execute(tx),
      );
      expect(await standing(grad)).toEqual({ status: 0, inactive_reason: 4 });
      await expect(
        read((tx) =>
          sql`update students set inactive_reason = 5 where id = ${grad.id}`.execute(tx),
        ),
      ).rejects.toThrow(/ck_students_inactive/);
    });

    it('refuses a target class below the source class, for PRM-01 and for STU-09, and changes nothing', async () => {
      const grad = await admit(tenAYear1, '7');
      const lower = { ...target({ ...nineA, academicYearId: year2 }) };
      const res = await promote({
        institutionId: first,
        fromAcademicYearId: year1,
        fromClassId: class10,
        fromSectionId: null,
        ...lower,
      });
      expect([res.status, res.body.code]).toEqual([422, 'TARGET_CLASS_BELOW_SOURCE']);
      const one = await promoteOne(grad, lower);
      expect([one.status, one.body.code]).toEqual([422, 'TARGET_CLASS_BELOW_SOURCE']);
      expect((await history(grad)).length).toBe(1);
      expect(await standing(grad)).toEqual({ status: 1, inactive_reason: null });
    });

    it('lets a student repeat the class in the next year', async () => {
      const again = { ...target({ ...nineA, academicYearId: year2 }) };
      const res = await promote(fromNineA(again));
      expect(res.status).toBe(200);
      expect(await history(diya)).toMatchObject([{ outcome: 2 }, { class_id: class9 }]);
    });

    it.each([
      [
        'completing a class that is not the last',
        () => ({ fromSectionId: null, ...nobody }),
        422,
        'NOT_FINAL_CLASS',
      ],
      [
        'a target year that does not begin after the source year',
        () => ({ ...target({ ...tenA, academicYearId: year1 }) }),
        422,
        'TARGET_YEAR_NOT_AFTER_SOURCE',
      ],
      [
        'a section that is not of the target class',
        () => ({ toClassId: class9 }),
        422,
        'SECTION_NOT_IN_CLASS',
      ],
      ['a target part left out', () => ({ toSectionId: null }), 400, 'VALIDATION_FAILED'],
      [
        'a target year of another Institution',
        () => ({ toAcademicYearId: abroadPlace.academicYearId }),
        404,
        'NOT_FOUND',
      ],
      [
        'a section of another Institution',
        () => ({ toClassId: abroadPlace.classId, toSectionId: abroadPlace.sectionId }),
        404,
        'NOT_FOUND',
      ],
      [
        'a source class that does not exist',
        () => ({ fromClassId: randomUUID() }),
        404,
        'NOT_FOUND',
      ],
    ])('refuses %s, and changes nothing', async (_name, fields, status, code) => {
      const res = await promote(fromNineA(fields()));
      expect([res.status, res.body.code]).toEqual([status, code]);
      expect((await history(diya)).length).toBe(1);
    });

    it('refuses a target year that is not active', async () => {
      const closed = await api('delete', `/v1/academic-years/${year2}`, owner.token);
      expect(closed.status).toBe(200);
      const res = await promote(fromNineA());
      expect([res.status, res.body.code]).toEqual([422, 'YEAR_NOT_ACTIVE']);
    });

    it('is 413 BATCH_TOO_LARGE for more than 500 students', async () => {
      const many = Array.from({ length: 501 }, () => randomUUID());
      const res = await promote(fromNineA({ studentIds: many }));
      expect([res.status, res.body.code]).toEqual([413, 'BATCH_TOO_LARGE']);
    });

    it('is 422 SECTION_NOT_IN_CLASS for a source section of another class, and writes nothing', async () => {
      const res = await promote(fromNineA({ fromSectionId: tenA.sectionId }));
      expect([res.status, res.body.code]).toEqual([422, 'SECTION_NOT_IN_CLASS']);
      expect((await history(diya)).length).toBe(1);
      expect((await profile(diya)).placement.academicYearId).toBe(year1);
      expect(await audits()).toEqual([]);
    });

    it('is 404 for a source year the caller cannot see, another Institution’s or unknown, and writes nothing', async () => {
      for (const fromAcademicYearId of [abroadPlace.academicYearId, randomUUID()]) {
        const res = await promote(fromNineA({ fromAcademicYearId }));
        expect([res.status, res.body.code]).toEqual([404, 'NOT_FOUND']);
      }
      expect((await history(diya)).length).toBe(1);
      expect(await audits()).toEqual([]);
    });

    it('is 400 REQUIRED for a target part, a source section or a student list that is left out or empty', async () => {
      for (const field of ['toAcademicYearId', 'toClassId', 'toSectionId', 'fromSectionId']) {
        const res = await promote(fromNineA({ [field]: undefined }));
        expect([res.status, res.body.code, res.body.errors?.[0]]).toMatchObject([
          400,
          'VALIDATION_FAILED',
          { field, code: 'REQUIRED' },
        ]);
      }
      const none = await promote(fromNineA({ studentIds: [] }));
      expect([none.status, none.body.errors?.[0]]).toMatchObject([
        400,
        { field: 'studentIds', code: 'REQUIRED' },
      ]);
      expect((await history(diya)).length).toBe(1);
    });

    describe('while another change to the same students commits', () => {
      it('leaves out a student who was moved to another section meanwhile, instead of closing a placement that is closed', async () => {
        const res = await racing(
          diya,
          () => promote(fromNineA({ studentIds: [diya.id, ravi.id] })),
          async (tx) => {
            // STU-08: the old placement ends and a new one begins in 9B.
            await sql`update student_section_placements set end_date = '2026-08-01'
              where student_enrolment_id in (select id from student_enrolments where student_id = ${diya.id})`.execute(
              tx,
            );
            await sql`insert into student_section_placements (society_id, institution_id, academic_year_id,
                student_enrolment_id, class_id, section_id, roll_number, start_date)
              select society_id, institution_id, academic_year_id, student_enrolment_id, class_id,
                ${nineB.sectionId}, '9', '2026-08-02'
              from student_section_placements
              where student_enrolment_id in (select id from student_enrolments where student_id = ${diya.id})`.execute(
              tx,
            );
          },
        );
        expect([res.status, res.body.code]).toEqual([200, 'PROMOTED']);
        expect(res.body.data).toEqual({
          promotedCount: 1,
          skipped: [{ studentId: diya.id, reason: 'NOT_IN_SOURCE' }],
        });
        expect(await history(diya)).toMatchObject([
          { year: year1, section_id: nineA.sectionId, end_date: '2026-08-01' },
          { year: year1, section_id: nineB.sectionId, roll_number: '9', end_date: null },
        ]);
        expect((await profile(ravi)).placement.academicYearId).toBe(year2);
      });

      it('promotes a student once when two promotions of the class to later years run at the same time', async () => {
        const year3 = await kit.year(owner.token, first, {
          name: '2028-2029',
          startDate: '2028-06-01',
          endDate: '2029-03-31',
        });
        const toYear3 = { ...tenA, academicYearId: year3 };
        const answers = await racing(
          diya,
          () => Promise.all([promote(fromNineA()), promote(fromNineA(target(toYear3)))]),
          async () => undefined,
        );
        expect(answers.map((res) => res.status)).toEqual([200, 200]);
        // One call got the locks first and promoted both students; the other found the old placements closed.
        expect(answers.map((res) => res.body.data.promotedCount).toSorted()).toEqual([0, 2]);
        for (const student of [diya, ravi]) {
          const rows = await history(student);
          expect(rows.filter((row) => row.status === 1 && row.end_date === null)).toHaveLength(1);
          expect(rows.filter((row) => row.outcome === 1)).toHaveLength(1);
        }
      });
    });

    it('is for the Owner and the Admins of the Institution, and no teacher, Super Admin or stranger', async () => {
      expect((await promote(fromNineA(), randomUUID(), institutionAdmin.token)).status).toBe(200);
      const teacher = await kit.staff(
        owner.token,
        first,
        (await kit.masters(admin, 'class-categories'))[0]!.id,
      );
      const asTeacher = await kit.actingAs(teacher.person.email, TEACHER, societyId);
      expect((await promote(fromNineA(), randomUUID(), asTeacher)).status).toBe(403);
      expect((await promote(fromNineA(), randomUUID(), admin)).status).toBe(403);
      const other = await fixtures.owner(await kit.society(admin));
      expect((await promote(fromNineA(), randomUUID(), other.token)).status).toBe(404);
      const body = { ...fromNineA(), institutionId: second };
      expect((await promote(body, randomUUID(), institutionAdmin.token)).status).toBe(404);
    });
  });

  describe('STU-09 promote one student', () => {
    it('moves the student to the next year, takes the roll number given, and answers the profile', async () => {
      const res = await promoteOne(diya, { ...target(tenA), rollNumber: '21' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: diya.id,
        placement: {
          academicYearId: year2,
          classId: class10,
          sectionId: tenA.sectionId,
          rollNumber: '21',
        },
      });
      expect((await history(diya))[0]).toMatchObject({ outcome: 1, end_date: '2027-03-31' });
      expect((await profile(ravi)).placement.academicYearId).toBe(year1);
      expect(await audits()).toEqual([
        { entityId: diya.id, after: expect.objectContaining({ promotedCount: 1 }) },
      ]);
    });

    it('keeps the roll number by default, and the old one is free for the section again', async () => {
      await promoteOne(diya, target(tenA));
      expect((await profile(diya)).placement.rollNumber).toBe('1');
      const newcomer = await admit(nineA, '1');
      expect(newcomer.placement.rollNumber).toBe('1');
    });

    it('is 422 once the student is in the new year, because that year does not begin after their current one', async () => {
      await promoteOne(diya, target(tenA));
      const res = await promoteOne(diya, target(tenA));
      expect([res.status, res.body.code]).toEqual([422, 'TARGET_YEAR_NOT_AFTER_SOURCE']);
    });

    it('is 409 ROLL_NUMBER_TAKEN for a roll number the new section holds', async () => {
      await promoteOne(ravi, { ...target(tenA), rollNumber: '5' });
      const res = await promoteOne(diya, { ...target(tenA), rollNumber: '5' });
      expect([res.status, res.body.code]).toEqual([409, 'ROLL_NUMBER_TAKEN']);
      expect((await profile(diya)).placement.academicYearId).toBe(year1);
    });

    it('completes the final class for a student with no target', async () => {
      const grad = await admit(tenAYear1, '7');
      const res = await promoteOne(grad, nobody);
      expect(res.status).toBe(200);
      // The profile of a deactivated student is still read (STU-03).
      expect(res.body.data).toMatchObject({ id: grad.id, status: 0 });
      expect(await standing(grad)).toEqual({ status: 0, inactive_reason: 4 });
      expect(await history(grad)).toMatchObject([{ outcome: 4, end_date: '2027-03-31' }]);
      expect((await promoteOne(diya, nobody)).body.code).toBe('NOT_FINAL_CLASS');
    });

    it('is 404 for a deactivated student, a stranger’s and another Institution’s, and 400 for half a target', async () => {
      await api('delete', `/v1/students/${ravi.id}?reason=1`, owner.token);
      expect((await promoteOne(ravi, target(tenA))).status).toBe(404);
      const other = await fixtures.owner(await kit.society(admin));
      expect((await promoteOne(diya, target(tenA), other.token)).status).toBe(404);
      const abroad = await admit(abroadPlace, '1', second);
      expect((await promoteOne(abroad, target(tenA), institutionAdmin.token)).status).toBe(404);
      expect((await promoteOne(diya, { ...target(tenA), toClassId: null })).status).toBe(400);
    });

    it('is for the Owner and the Admins, and no teacher or Super Admin', async () => {
      expect((await promoteOne(diya, target(tenA), admin)).status).toBe(403);
      const teacher = await kit.staff(
        owner.token,
        first,
        (await kit.masters(admin, 'class-categories'))[0]!.id,
      );
      const asTeacher = await kit.actingAs(teacher.person.email, TEACHER, societyId);
      expect((await promoteOne(diya, target(tenA), asTeacher)).status).toBe(403);
      expect((await promoteOne(diya, target(tenA), institutionAdmin.token)).status).toBe(200);
    });
  });
});
