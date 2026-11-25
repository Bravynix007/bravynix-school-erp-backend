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
import { SchoolKit, succeeded, type SchoolStaff } from '../support/school-kit.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '0192f3b0-0000-7000-8000-00000000ffff';
const TEACHER = 4;

interface Paper {
  id: string;
  examId: string;
  institutionId: string;
  sectionId: string;
  sectionName: string | null;
  className: string | null;
  subject: { id: string; name: string };
  examDate: string;
  startTime: string;
  endTime: string;
  roomName: string | null;
  maxMarks: number;
  passingMarks: number;
  subjectTeacher: { id: string; displayName: string } | null;
  invigilator: { id: string; displayName: string } | null;
  status: number;
  version: number;
}

const fieldsOf = (res: { body: { errors?: { field: string; code: string }[] } }) =>
  Object.fromEntries((res.body.errors ?? []).map((e) => [e.field, e.code]));

const parentEmail = `${Math.random().toString(36).slice(2)}@parent.test`;
const guardian = (email: string) => ({
  firstName: 'Ravi',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  email,
  isPrimary: true,
  isEmergencyContact: true,
});

describe('EXM-05 to EXM-08 exam papers (API design 9.8, 12.6)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;

  /** Society A: the first Institution has a year, an exam, two sections, two subjects and three staff. */
  let societyA: string;
  let first: string;
  let second: string;
  let year: string;
  let exam: string;
  let owner: SignedInPerson;
  let firstAdmin: SignedInPerson;
  let secondAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let sectionA: string;
  let sectionB: string;
  let sectionOfSecond: string;
  let maths: string;
  let english: string;
  let anna: SchoolStaff;
  let ben: SchoolStaff;
  let cara: SchoolStaff;
  let dev: SchoolStaff;
  let annaToken: string;
  let parentToken: string;
  let strangerToken: string;
  let childId: string;
  let strangerChild: string;
  let categoryId: string;

  const paperBody = (fields: object = {}) => ({
    sectionId: sectionA,
    subjectId: maths,
    examDate: '2026-08-10',
    startTime: '09:00',
    endTime: '11:00',
    ...fields,
  });
  const add = (fields: object = {}, token = owner.token, examId = exam) =>
    api('post', `/v1/exams/${examId}/papers`, token, paperBody(fields));
  const added = async (fields: object = {}, token = owner.token) =>
    succeeded(await add(fields, token), 201, 'paper').body.data as unknown as Paper;
  const edit = (id: string, fields: object, token = owner.token) =>
    api('patch', `/v1/exam-papers/${id}`, token, fields);
  const remove = (id: string, token = owner.token) => api('delete', `/v1/exam-papers/${id}`, token);
  const papers = async (query = '', token = owner.token, examId = exam) => {
    const res = await api('get', `/v1/exams/${examId}/papers${query}`, token);
    expect([res.status, query]).toEqual([200, query]);
    return res.body.data as unknown as Paper[];
  };
  /** Two saves at once for the same time: one wins, the other is refused with the code of what they share. */
  const race = async (one: object, other: object, code: string) => {
    const results = await Promise.all([add(one), add(other)]);
    expect(results.map((r) => r.status).toSorted()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe(code);
  };
  const removeExam = () => api('delete', `/v1/exams/${exam}`, owner.token);
  const moveTo = (fields: object, version = 1) =>
    api('patch', `/v1/exams/${exam}`, owner.token, { version, ...fields });
  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      institution_id: string | null;
      society_id: string | null;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);
  const teach = async (staff: SchoolStaff, subjectIds: string[]) =>
    succeeded(
      await api('put', `/v1/staff/${staff.id}/subjects`, owner.token, { subjectIds }),
      200,
      'subjects',
    );
  /** What EXM-09 will do (Phase 6 B3b), written as the Owner's session would. */
  const publish = (examId = exam) =>
    database.transaction(
      { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
      (tx) =>
        sql`update exams set datesheet_published_at = now(), datesheet_published_by = ${owner.person}
            where id = ${examId}`.execute(tx),
    );

  /** A raw insert into the table, as the app role would, for what the table itself must refuse. */
  const insert = (columns: ReturnType<typeof sql>, values: ReturnType<typeof sql>) =>
    database.transaction(
      { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
      (tx) =>
        sql`insert into exam_papers (society_id, institution_id, academic_year_id, exam_id, section_id, subject_id, ${columns})
              values (${societyA}, ${first}, ${year}, ${exam}, ${sectionA}, ${maths}, ${values})`.execute(
          tx,
        ),
    );
  /** The papers a session reads when the request names these children. */
  const seenAsParent = (childIds: string[]) =>
    database.transaction({ personId: owner.person, roleCode: 5, childIds }, async (tx) =>
      (await tx.selectFrom('exam_papers').select('id').execute()).map((row) => row.id),
    );

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
    const predefinedClass = (await kit.masters(admin, 'predefined-classes')).find(
      (c) => c.code === 'C10',
    )!.id;
    const predefinedSections = await kit.masters(admin, 'predefined-sections');
    const sectionCode = (code: string) => predefinedSections.find((s) => s.code === code)!.id;
    societyA = await kit.society(admin);
    owner = await fixtures.owner(societyA);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    year = await kit.year(owner.token, first);
    await kit.year(owner.token, second);
    firstAdmin = await fixtures.institutionAdmin(societyA, [first]);
    secondAdmin = await fixtures.institutionAdmin(societyA, [second]);
    otherOwner = await fixtures.owner(await kit.society(admin));
    exam = (
      succeeded(
        await api('post', '/v1/exams', owner.token, {
          institutionId: first,
          name: 'Unit Test 1',
          examType: 1,
          startDate: '2026-08-10',
          endDate: '2026-08-14',
        }),
        201,
        'exam',
      ).body.data as { id: string }
    ).id;
    const classId = await kit.klass(owner.token, first, predefinedClass);
    sectionA = await kit.section(owner.token, classId, sectionCode('A'));
    sectionB = await kit.section(owner.token, classId, sectionCode('B'));
    sectionOfSecond = await kit.section(
      owner.token,
      await kit.klass(owner.token, second, predefinedClass),
      sectionCode('A'),
    );
    maths = await kit.subject(owner.token, 'Mathematics');
    english = await kit.subject(owner.token, 'English');
    const person = (name: string, home = first) =>
      kit.staff(owner.token, home, categoryId, { firstName: name, lastName: 'Rao' });
    anna = await person('Anna');
    ben = await person('Ben');
    cara = await person('Cara');
    dev = await person('Dev', second);
    await teach(anna, [maths, english]);
    await teach(ben, [maths]);
    await teach(dev, [maths]);
    annaToken = await kit.actingAs(anna.person.email, TEACHER, societyA);
    const place = { academicYearId: year, classId, sectionId: sectionA };
    childId = (await kit.student(owner.token, first, place, { guardians: [guardian(parentEmail)] }))
      .id;
    parentToken = (await signInMobile(t, parentEmail)).accessToken;
    const strangerEmail = `${Math.random().toString(36).slice(2)}@parent.test`;
    const strangerInstitution = await kit.institution(otherOwner.token, categoryId);
    const strangerYear = await kit.year(otherOwner.token, strangerInstitution);
    const strangerClass = await kit.klass(otherOwner.token, strangerInstitution, predefinedClass);
    const strangerSection = await kit.section(otherOwner.token, strangerClass, sectionCode('A'));
    strangerChild = (
      await kit.student(
        otherOwner.token,
        strangerInstitution,
        { academicYearId: strangerYear, classId: strangerClass, sectionId: strangerSection },
        { guardians: [guardian(strangerEmail)] },
      )
    ).id;
    strangerToken = (await signInMobile(t, strangerEmail)).accessToken;
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('EXM-06 add', () => {
    it('lets the Owner and the Admin add a paper, shown with its section, subject, people and times as written', async () => {
      const paper = await added({
        roomName: 'Room 12',
        maxMarks: 80,
        passingMarks: 28,
        subjectTeacherStaffMemberId: anna.id,
        invigilatorStaffMemberId: cara.id,
      });
      expect(paper).toMatchObject({
        examId: exam,
        institutionId: first,
        sectionId: sectionA,
        sectionName: 'A',
        className: '10th',
        subject: { id: maths, name: 'Mathematics' },
        examDate: '2026-08-10',
        startTime: '09:00',
        endTime: '11:00',
        roomName: 'Room 12',
        maxMarks: 80,
        passingMarks: 28,
        subjectTeacher: { id: anna.id, displayName: 'Anna Rao' },
        invigilator: { id: cara.id, displayName: 'Cara Rao' },
        status: 1,
        version: 1,
      });
      const byAdmin = await added(
        { sectionId: sectionB, examDate: '2026-08-11' },
        firstAdmin.token,
      );
      expect(byAdmin).toMatchObject({ sectionName: 'B', roomName: null, subjectTeacher: null });
      expect(await audit(paper.id)).toEqual([
        expect.objectContaining({
          action: 'exam_paper.created',
          institution_id: first,
          society_id: societyA,
          new_values: expect.objectContaining({
            section_id: sectionA,
            start_time: '09:00',
            max_marks: 80,
          }),
        }),
      ]);
    });

    it('marks out of 100 with 35 to pass unless told otherwise, and never passes above a lower maximum', async () => {
      expect(await added()).toMatchObject({ maxMarks: 100, passingMarks: 35 });
      expect(await added({ sectionId: sectionB, maxMarks: 20 })).toMatchObject({
        maxMarks: 20,
        passingMarks: 20,
      });
    });

    it('needs the section, the subject, the day and the times (400), and refuses unknown fields', async () => {
      const res = await api('post', `/v1/exams/${exam}/papers`, owner.token, {});
      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual({
        sectionId: 'REQUIRED',
        subjectId: 'REQUIRED',
        examDate: 'REQUIRED',
        startTime: 'REQUIRED',
        endTime: 'REQUIRED',
      });
      expect(fieldsOf(await add({ examId: exam, status: 0 }))).toEqual({
        examId: 'FIELD_NOT_ALLOWED',
        status: 'FIELD_NOT_ALLOWED',
      });
      expect(fieldsOf(await add({ maxMarks: 1001 }))).toEqual({ maxMarks: 'OUT_OF_RANGE' });
      expect(fieldsOf(await add({ maxMarks: '50' }))).toEqual({ maxMarks: 'INVALID_TYPE' });
    });

    it('refuses a day outside the exam, an end not after the start and passing marks above the maximum (400 OUT_OF_RANGE)', async () => {
      for (const examDate of ['2026-08-09', '2026-08-15']) {
        const res = await add({ examDate });
        expect(res.status).toBe(400);
        expect(fieldsOf(res)).toEqual({ examDate: 'OUT_OF_RANGE' });
      }
      expect((await add({ examDate: '2026-08-14' })).status).toBe(201);
      for (const endTime of ['09:00', '08:59']) {
        expect(fieldsOf(await add({ sectionId: sectionB, endTime }))).toEqual({
          endTime: 'OUT_OF_RANGE',
        });
      }
      expect(fieldsOf(await add({ sectionId: sectionB, maxMarks: 50, passingMarks: 51 }))).toEqual({
        passingMarks: 'OUT_OF_RANGE',
      });
    });

    it('is 404 for an exam, a section or a subject that does not exist, and for a section of another Institution', async () => {
      expect((await add({}, owner.token, missing)).status).toBe(404);
      expect((await add({ sectionId: missing })).status).toBe(404);
      expect((await add({ sectionId: sectionOfSecond })).status).toBe(404);
      expect((await add({ subjectId: missing })).status).toBe(404);
    });

    it('refuses a deactivated subject (422 REFERENCE_INACTIVE) and a deactivated exam (404)', async () => {
      await api('delete', `/v1/subjects/${english}`, owner.token);
      const res = await add({ subjectId: english });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toEqual({ subjectId: 'REFERENCE_INACTIVE' });
      await api('delete', `/v1/exams/${exam}`, owner.token);
      expect((await add()).status).toBe(404);
    });

    it('takes a teacher who teaches the subject, and refuses one who does not, who is elsewhere, gone or unknown', async () => {
      const unqualified = await add({
        subjectTeacherStaffMemberId: ben.id,
        subjectId: english,
      });
      expect([unqualified.status, unqualified.body.code]).toEqual([422, 'SUBJECT_NOT_TAUGHT']);
      expect((await add({ subjectTeacherStaffMemberId: cara.id })).body.code).toBe(
        'SUBJECT_NOT_TAUGHT',
      );
      const elsewhere = await add({ subjectTeacherStaffMemberId: dev.id });
      expect([elsewhere.status, elsewhere.body.code]).toEqual([422, 'STAFF_NOT_AT_INSTITUTION']);
      expect((await add({ subjectTeacherStaffMemberId: missing })).status).toBe(404);
      await api('delete', `/v1/staff/${ben.id}`, owner.token);
      const gone = await add({ subjectTeacherStaffMemberId: ben.id });
      expect(gone.status).toBe(422);
      expect(fieldsOf(gone)).toEqual({ subjectTeacherStaffMemberId: 'REFERENCE_INACTIVE' });
    });

    it('takes any staff member of the Institution as invigilator, and refuses one of another, gone or unknown', async () => {
      expect((await added({ invigilatorStaffMemberId: cara.id })).invigilator).toMatchObject({
        id: cara.id,
      });
      const elsewhere = await add({ sectionId: sectionB, invigilatorStaffMemberId: dev.id });
      expect([elsewhere.status, elsewhere.body.code]).toEqual([422, 'STAFF_NOT_AT_INSTITUTION']);
      expect((await add({ invigilatorStaffMemberId: missing })).status).toBe(404);
      await api('delete', `/v1/staff/${ben.id}`, owner.token);
      const gone = await add({ sectionId: sectionB, invigilatorStaffMemberId: ben.id });
      expect(fieldsOf(gone)).toEqual({ invigilatorStaffMemberId: 'REFERENCE_INACTIVE' });
    });

    it('refuses a subject set twice for a section in an exam (409 DUPLICATE), and allows it for another section or exam', async () => {
      await added();
      const again = await add({ examDate: '2026-08-12' });
      expect([again.status, again.body.code]).toEqual([409, 'DUPLICATE']);
      expect(fieldsOf(again)).toEqual({ subjectId: 'DUPLICATE' });
      expect((await add({ sectionId: sectionB })).status).toBe(201);
      const other = succeeded(
        await api('post', '/v1/exams', owner.token, {
          institutionId: first,
          name: 'Term 1',
          examType: 2,
          startDate: '2026-09-21',
          endDate: '2026-09-30',
        }),
        201,
        'exam',
      ).body.data as { id: string };
      expect((await add({ examDate: '2026-09-22' }, owner.token, other.id)).status).toBe(201);
    });

    it('refuses a paper that overlaps another of the section, not one that only touches it (409 PAPER_OVERLAP)', async () => {
      await added();
      for (const [startTime, endTime] of [
        ['10:00', '12:00'],
        ['08:00', '09:30'],
        ['09:30', '10:00'],
        ['08:00', '12:00'],
      ]) {
        const res = await add({ subjectId: english, startTime, endTime });
        expect([res.status, res.body.code]).toEqual([409, 'PAPER_OVERLAP']);
        expect(fieldsOf(res)).toEqual({ startTime: 'PAPER_OVERLAP' });
      }
      expect((await add({ subjectId: english, startTime: '11:00', endTime: '12:00' })).status).toBe(
        201,
      );
      expect((await add({ sectionId: sectionB })).status).toBe(201);
    });

    it('refuses an invigilator in two places at once (409 INVIGILATOR_DOUBLE_BOOKED)', async () => {
      await added({ invigilatorStaffMemberId: cara.id });
      const res = await add({
        sectionId: sectionB,
        startTime: '10:00',
        endTime: '12:00',
        invigilatorStaffMemberId: cara.id,
      });
      expect([res.status, res.body.code]).toEqual([409, 'INVIGILATOR_DOUBLE_BOOKED']);
      expect(fieldsOf(res)).toEqual({ invigilatorStaffMemberId: 'INVIGILATOR_DOUBLE_BOOKED' });
      const free = await add({
        sectionId: sectionB,
        startTime: '11:00',
        endTime: '12:00',
        invigilatorStaffMemberId: cara.id,
      });
      expect(free.status).toBe(201);
    });

    it('refuses a room taken at that time, in any letter case, and a room is free at other times (409 ROOM_TAKEN)', async () => {
      await added({ roomName: 'Room 12' });
      const res = await add({ sectionId: sectionB, roomName: 'ROOM 12' });
      expect([res.status, res.body.code]).toEqual([409, 'ROOM_TAKEN']);
      expect(fieldsOf(res)).toEqual({ roomName: 'ROOM_TAKEN' });
      const later = {
        sectionId: sectionB,
        roomName: 'Room 12',
        startTime: '11:00',
        endTime: '12:00',
      };
      expect((await add(later)).status).toBe(201);
      const nextDay = { sectionId: sectionB, subjectId: english, examDate: '2026-08-11' };
      expect((await add({ ...nextDay, roomName: 'Room 12' })).status).toBe(201);
    });

    it('frees the section, the invigilator and the room again when a paper is removed', async () => {
      const gone = await added({ roomName: 'Room 12', invigilatorStaffMemberId: cara.id });
      await remove(gone.id);
      expect(
        (
          await add({
            roomName: 'Room 12',
            invigilatorStaffMemberId: cara.id,
          })
        ).status,
      ).toBe(201);
    });

    it('lets only one of two saves of the same time at once in, for the section', () =>
      race({}, { subjectId: english }, 'PAPER_OVERLAP'));

    it('lets only one of two saves of the same time at once in, for the invigilator', () =>
      race(
        { invigilatorStaffMemberId: cara.id },
        { sectionId: sectionB, invigilatorStaffMemberId: cara.id },
        'INVIGILATOR_DOUBLE_BOOKED',
      ));

    it('lets only one of two saves of the same time at once in, for the room', () =>
      race({ roomName: 'Hall' }, { sectionId: sectionB, roomName: 'Hall' }, 'ROOM_TAKEN'));

    it('is for the Owner and the Admin of the Institution only', async () => {
      expect((await add({}, annaToken)).status).toBe(403);
      expect((await add({}, parentToken)).status).toBe(403);
      expect((await add({}, secondAdmin.token)).status).toBe(404);
      expect((await add({}, otherOwner.token)).status).toBe(404);
      expect((await add({}, strangerToken)).status).toBe(403);
    });
  });

  describe('EXM-07 edit', () => {
    it('changes the day, times, room, marks and people, and audits the change with before and after', async () => {
      const paper = await added({ roomName: 'Room 12', maxMarks: 100, passingMarks: 35 });
      const res = await edit(paper.id, {
        version: paper.version,
        examDate: '2026-08-11',
        startTime: '10:00',
        endTime: '12:30',
        roomName: 'Hall',
        maxMarks: 60,
        passingMarks: 21,
        subjectTeacherStaffMemberId: anna.id,
        invigilatorStaffMemberId: cara.id,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        examDate: '2026-08-11',
        startTime: '10:00',
        endTime: '12:30',
        roomName: 'Hall',
        maxMarks: 60,
        passingMarks: 21,
        subjectTeacher: { id: anna.id },
        invigilator: { id: cara.id },
        version: 2,
      });
      const [, updated] = await audit(paper.id);
      expect(updated).toMatchObject({
        action: 'exam_paper.updated',
        old_values: expect.objectContaining({ start_time: '09:00', room_name: 'Room 12' }),
        new_values: expect.objectContaining({ start_time: '10:00', room_name: 'Hall' }),
      });
    });

    it('clears the room, the teacher and the invigilator with null', async () => {
      const paper = await added({
        roomName: 'Room 12',
        subjectTeacherStaffMemberId: anna.id,
        invigilatorStaffMemberId: cara.id,
      });
      const res = await edit(paper.id, {
        version: 1,
        roomName: null,
        subjectTeacherStaffMemberId: null,
        invigilatorStaffMemberId: null,
      });
      expect(res.body.data).toMatchObject({
        roomName: null,
        subjectTeacher: null,
        invigilator: null,
      });
    });

    it('writes nothing for a request that changes nothing, and answers the version it holds', async () => {
      const paper = await added({ roomName: 'Room 12' });
      const res = await edit(paper.id, {
        version: 1,
        startTime: '09:00',
        roomName: 'Room 12',
        examDate: '2026-08-10',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(1);
      expect(await audit(paper.id)).toHaveLength(1);
    });

    it('needs the version, and answers VERSION_CONFLICT for a stale one (409)', async () => {
      const paper = await added();
      expect(fieldsOf(await edit(paper.id, { roomName: 'X' }))).toEqual({ version: 'REQUIRED' });
      await edit(paper.id, { version: 1, roomName: 'Room 1' });
      const stale = await edit(paper.id, { version: 1, roomName: 'Room 2' });
      expect([stale.status, stale.body.code]).toEqual([409, 'VERSION_CONFLICT']);
    });

    it('refuses what EXM-06 refuses on what it changes (400, 404, 422, 409)', async () => {
      const paper = await added();
      await added({ subjectId: english, examDate: '2026-08-11' });
      expect(fieldsOf(await edit(paper.id, { version: 1, examDate: '2026-08-15' }))).toEqual({
        examDate: 'OUT_OF_RANGE',
      });
      expect(fieldsOf(await edit(paper.id, { version: 1, endTime: '08:59' }))).toEqual({
        endTime: 'OUT_OF_RANGE',
      });
      expect(fieldsOf(await edit(paper.id, { version: 1, startTime: '11:00' }))).toEqual({
        endTime: 'OUT_OF_RANGE',
      });
      expect(fieldsOf(await edit(paper.id, { version: 1, passingMarks: 101 }))).toEqual({
        passingMarks: 'OUT_OF_RANGE',
      });
      expect(fieldsOf(await edit(paper.id, { version: 1, maxMarks: 30 }))).toEqual({
        passingMarks: 'OUT_OF_RANGE',
      });
      expect(
        (await edit(paper.id, { version: 1, subjectTeacherStaffMemberId: cara.id })).body.code,
      ).toBe('SUBJECT_NOT_TAUGHT');
      expect(
        (await edit(paper.id, { version: 1, invigilatorStaffMemberId: dev.id })).body.code,
      ).toBe('STAFF_NOT_AT_INSTITUTION');
      const overlap = await edit(paper.id, { version: 1, examDate: '2026-08-11' });
      expect([overlap.status, overlap.body.code]).toEqual([409, 'PAPER_OVERLAP']);
    });

    it('does not clash with itself, and refuses a room or invigilator another paper holds', async () => {
      const paper = await added({ roomName: 'Room 12', invigilatorStaffMemberId: cara.id });
      expect(
        (await edit(paper.id, { version: 1, startTime: '09:30', endTime: '10:30' })).status,
      ).toBe(200);
      const other = await added({ sectionId: sectionB, examDate: '2026-08-11' });
      const room = await edit(other.id, {
        version: 1,
        examDate: '2026-08-10',
        roomName: 'room 12',
      });
      expect([room.status, room.body.code]).toEqual([409, 'ROOM_TAKEN']);
      const invigilator = await edit(other.id, {
        version: 1,
        examDate: '2026-08-10',
        invigilatorStaffMemberId: cara.id,
      });
      expect([invigilator.status, invigilator.body.code]).toEqual([
        409,
        'INVIGILATOR_DOUBLE_BOOKED',
      ]);
    });

    it('does not refuse a change of room for a teacher who has since left', async () => {
      const paper = await added({ subjectTeacherStaffMemberId: ben.id });
      await api('delete', `/v1/staff/${ben.id}`, owner.token);
      const res = await edit(paper.id, { version: 1, roomName: 'Room 3' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ roomName: 'Room 3', subjectTeacher: { id: ben.id } });
    });

    it('keeps the exam, the section and the subject (400 FIELD_NOT_ALLOWED)', async () => {
      const paper = await added();
      expect(
        fieldsOf(
          await edit(paper.id, {
            version: 1,
            sectionId: sectionB,
            subjectId: english,
            examId: exam,
          }),
        ),
      ).toEqual({
        sectionId: 'FIELD_NOT_ALLOWED',
        subjectId: 'FIELD_NOT_ALLOWED',
        examId: 'FIELD_NOT_ALLOWED',
      });
    });

    it('is 404 for a removed paper or one out of reach, and for the Owner and the Admin only', async () => {
      const paper = await added();
      expect((await edit(paper.id, { version: 1 }, annaToken)).status).toBe(403);
      expect((await edit(paper.id, { version: 1 }, parentToken)).status).toBe(403);
      expect((await edit(paper.id, { version: 1 }, secondAdmin.token)).status).toBe(404);
      expect((await edit(paper.id, { version: 1 }, otherOwner.token)).status).toBe(404);
      expect((await edit(missing, { version: 1 })).status).toBe(404);
      await remove(paper.id);
      expect((await edit(paper.id, { version: 1 })).status).toBe(404);
    });
  });

  describe('EXM-08 deactivate', () => {
    it('removes the paper from the datesheet, audited, and is 404 the second time', async () => {
      const paper = await added();
      const res = await remove(paper.id, firstAdmin.token);
      expect([res.status, res.body.data]).toEqual([200, { id: paper.id, status: 0 }]);
      expect(await papers()).toEqual([]);
      expect(await audit(paper.id)).toEqual([
        expect.objectContaining({ action: 'exam_paper.created' }),
        expect.objectContaining({
          action: 'exam_paper.deactivated',
          old_values: expect.objectContaining({ status: 1 }),
          new_values: expect.objectContaining({ status: 0 }),
        }),
      ]);
      expect((await remove(paper.id)).status).toBe(404);
    });

    it('is for the Owner and the Admin of the Institution only', async () => {
      const paper = await added();
      expect((await remove(paper.id, annaToken)).status).toBe(403);
      expect((await remove(paper.id, secondAdmin.token)).status).toBe(404);
      expect((await remove(paper.id, otherOwner.token)).status).toBe(404);
      expect((await remove(missing)).status).toBe(404);
      expect(await papers()).toHaveLength(1);
    });
  });

  describe('EXM-05 list', () => {
    it('lists the papers in the order they are sat, one section’s with sectionId', async () => {
      const late = await added({ sectionId: sectionB, examDate: '2026-08-12' });
      const middle = await added({
        sectionId: sectionB,
        subjectId: english,
        examDate: '2026-08-11',
      });
      const early = await added({ examDate: '2026-08-11', startTime: '08:00', endTime: '09:00' });
      expect((await papers()).map((p) => p.id)).toEqual([early.id, middle.id, late.id]);
      expect((await papers(`?sectionId=${sectionB}`)).map((p) => p.id)).toEqual([
        middle.id,
        late.id,
      ]);
      expect(await papers(`?sectionId=${missing}`)).toEqual([]);
    });

    it('is open to the Owner, the Admin and a teacher of the Institution, and not to one out of reach (404)', async () => {
      const paper = await added();
      for (const token of [owner.token, firstAdmin.token, annaToken]) {
        expect(await papers('', token)).toHaveLength(1);
      }
      for (const token of [secondAdmin.token, otherOwner.token]) {
        expect((await api('get', `/v1/exams/${exam}/papers`, token)).status).toBe(404);
      }
      expect((await api('get', `/v1/exams/${missing}/papers`, owner.token)).status).toBe(404);
      await remove(paper.id);
      await api('delete', `/v1/exams/${exam}`, owner.token);
      expect((await api('get', `/v1/exams/${exam}/papers`, owner.token)).status).toBe(404);
    });

    it('refuses a child to anyone but a parent (400)', async () => {
      const res = await api('get', `/v1/exams/${exam}/papers?studentId=${childId}`, owner.token);
      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual({ studentId: 'FIELD_NOT_ALLOWED' });
    });

    it('gives a parent nothing until the datesheet is published, then their child’s section, without the people', async () => {
      await added({
        roomName: 'Room 12',
        subjectTeacherStaffMemberId: anna.id,
        invigilatorStaffMemberId: cara.id,
      });
      await added({ sectionId: sectionB });
      expect(await papers(`?studentId=${childId}`, parentToken)).toEqual([]);
      await publish();
      const seen = await papers(`?studentId=${childId}`, parentToken);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        sectionId: sectionA,
        sectionName: null,
        className: null,
        subject: { name: 'Mathematics' },
        startTime: '09:00',
        roomName: 'Room 12',
        maxMarks: 100,
        subjectTeacher: null,
        invigilator: null,
      });
    });

    it('asks a parent for their child, refuses a section, and is 404 for a child that is not theirs or another Institution’s exam', async () => {
      await publish();
      const none = await api('get', `/v1/exams/${exam}/papers`, parentToken);
      expect(fieldsOf(none)).toEqual({ studentId: 'REQUIRED' });
      const named = await api(
        'get',
        `/v1/exams/${exam}/papers?studentId=${childId}&sectionId=${sectionA}`,
        parentToken,
      );
      expect(fieldsOf(named)).toEqual({ sectionId: 'FIELD_NOT_ALLOWED' });
      expect(
        (await api('get', `/v1/exams/${exam}/papers?studentId=${strangerChild}`, parentToken))
          .status,
      ).toBe(404);
      expect(
        (await api('get', `/v1/exams/${exam}/papers?studentId=${childId}`, strangerToken)).status,
      ).toBe(404);
      const elsewhere = succeeded(
        await api('post', '/v1/exams', owner.token, {
          institutionId: second,
          name: 'Unit Test 1',
          examType: 1,
          startDate: '2026-08-10',
          endDate: '2026-08-14',
        }),
        201,
        'exam',
      ).body.data as { id: string };
      expect(
        (await api('get', `/v1/exams/${elsewhere.id}/papers?studentId=${childId}`, parentToken))
          .status,
      ).toBe(404);
    });

    it('shows the table to a parent as the datesheet of their child’s section once published, and to no other child', async () => {
      const mine = await added();
      const theirs = await added({ sectionId: sectionB });
      expect(await seenAsParent([childId])).toEqual([]);
      await publish();
      expect(await seenAsParent([childId])).toEqual([mine.id]);
      expect(await seenAsParent([strangerChild])).toEqual([]);
      expect(await seenAsParent([childId, strangerChild])).toEqual([mine.id]);
      expect(theirs.id).toBeDefined();
      await remove(mine.id);
      expect(await seenAsParent([childId])).toEqual([]);
    });
  });

  describe('EXM-04 deactivate an exam with papers', () => {
    it('refuses while the exam has an active paper (409 EXAM_IN_USE), and allows it once they are removed', async () => {
      const paper = await added({ roomName: 'Room 9' });
      const refused = await removeExam();
      expect([refused.status, refused.body.code]).toEqual([409, 'EXAM_IN_USE']);
      expect(await papers()).toHaveLength(1);
      await remove(paper.id);
      expect((await removeExam()).status).toBe(200);
    });

    it('lets two saves at once end with no orphan: the paper is added or the exam is deactivated', async () => {
      const [added409, gone] = await Promise.all([add(), removeExam()]);
      const outcomes = [added409.status, gone.status].toSorted();
      expect([
        [201, 409],
        [200, 404],
      ]).toContainEqual(outcomes);
    });
  });

  describe('EXM-03 dates against the papers', () => {
    it('refuses dates that leave an active paper outside them (409 PAPER_OUTSIDE_EXAM)', async () => {
      await added({ examDate: '2026-08-10' });
      const late = await added({ sectionId: sectionB, examDate: '2026-08-14' });
      for (const dates of [{ startDate: '2026-08-11' }, { endDate: '2026-08-13' }]) {
        const res = await moveTo(dates);
        expect([res.status, res.body.code]).toEqual([409, 'PAPER_OUTSIDE_EXAM']);
      }
      expect((await moveTo({ startDate: '2026-08-10', endDate: '2026-08-20' })).status).toBe(200);
      expect(late.id).toBeDefined();
    });

    it('lets a rename through, and the dates once the paper is moved or removed', async () => {
      const paper = await added({ examDate: '2026-08-10' });
      expect((await moveTo({ name: 'Unit Test One' })).status).toBe(200);
      expect((await moveTo({ startDate: '2026-08-11' }, 2)).status).toBe(409);
      await remove(paper.id);
      expect((await moveTo({ startDate: '2026-08-11' }, 2)).status).toBe(200);
    });
  });

  describe('the table', () => {
    it.each([
      [
        'an end at the start',
        sql`exam_date, start_time, end_time`,
        sql`'2026-08-10', '09:00', '09:00'`,
      ],
      [
        'no marks to give',
        sql`exam_date, start_time, end_time, max_marks`,
        sql`'2026-08-10', '09:00', '10:00', 0`,
      ],
      [
        'marks above the ceiling',
        sql`exam_date, start_time, end_time, max_marks`,
        sql`'2026-08-10', '09:00', '10:00', 1001`,
      ],
      [
        'passing marks above the maximum',
        sql`exam_date, start_time, end_time, max_marks, passing_marks`,
        sql`'2026-08-10', '09:00', '10:00', 50, 51`,
      ],
      [
        'a blank room',
        sql`exam_date, start_time, end_time, room_name`,
        sql`'2026-08-10', '09:00', '10:00', '  '`,
      ],
    ])('refuses %s', async (_label, columns, values) => {
      await expect(insert(columns, values)).rejects.toThrow(/ck_exam_papers/);
    });

    it('refuses a teacher of another Institution, a subject of another Society and an exam of another year', async () => {
      await expect(
        insert(
          sql`exam_date, start_time, end_time, invigilator_staff_member_id`,
          sql`'2026-08-10', '09:00', '10:00', ${dev.id}`,
        ),
      ).rejects.toThrow(/fk_exam_papers_invigilator/);
      await expect(
        insert(
          sql`exam_date, start_time, end_time, subject_teacher_staff_member_id`,
          sql`'2026-08-10', '09:00', '10:00', ${dev.id}`,
        ),
      ).rejects.toThrow(/fk_exam_papers_teacher/);
    });

    it('refuses an overlap the service never saw, as the app role', async () => {
      await added();
      await expect(
        insert(sql`exam_date, start_time, end_time`, sql`'2026-08-10', '10:00', '12:00'`),
      ).rejects.toMatchObject({ code: '23P01', constraint: 'ex_exam_papers_section_time' });
    });

    it('has no DELETE right for the app role', async () => {
      const paper = await added();
      await expect(
        database.transaction(
          { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
          (tx) => sql`delete from exam_papers where id = ${paper.id}`.execute(tx),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
