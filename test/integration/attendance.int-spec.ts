import { sql, Kysely, PostgresDialect } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { SectionRoster } from '../../src/modules/attendance/index.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { JobRunner } from '../../src/platform/jobs/index.js';
import { PushSender } from '../../src/platform/notifications/index.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { readJobs } from '../support/job-rows.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, succeeded, type SchoolStaff } from '../support/school-kit.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;
/** The IST day of the clock the test sets: 06:30 IST on this date, a moment before any real run of the suite. */
const TODAY = '2026-11-17';
const YESTERDAY = '2026-11-16';

interface RosterStudent {
  studentId: string;
  studentEnrolmentId: string;
  rollNumber: string;
  firstName: string;
  attendanceStatus: number;
}
interface Roster {
  section: { id: string; displayName: string; className: string };
  date: string;
  isHoliday: boolean;
  holidayTitle: string | null;
  canMark: boolean;
  existingSession: { id: string; version: number; submittedBy: { displayName: string } } | null;
  students: RosterStudent[];
}
interface Session {
  id: string;
  sectionId: string;
  sectionName: string;
  className: string;
  attendanceDate: string;
  rosterCount: number;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  halfDayCount: number;
  leaveCount: number;
  submittedBy: { id: string; displayName: string };
  marks?: { studentEnrolmentId: string; firstName: string; attendanceStatus: number }[];
}

const fieldsOf = (res: { body: { errors?: { field: string; code: string }[] } }) =>
  Object.fromEntries((res.body.errors ?? []).map((e) => [e.field, e.code]));

const guardianOf = (email: string) => ({
  firstName: 'Ravi',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  email,
  isPrimary: true,
  isEmergencyContact: true,
});
const parentEmail = () => `${Math.random().toString(36).slice(2)}@parent.test`;

describe('ATT-01 to ATT-04 mark attendance (API design 10.10, 10.11)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let runner: JobRunner;
  let admin: string;

  /** Society A: the first Institution has a year, a class with sections A and B, three children in A, one in B. */
  let societyA: string;
  let first: string;
  let second: string;
  let year: string;
  let classId: string;
  let owner: SignedInPerson;
  let firstAdmin: SignedInPerson;
  let secondAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let sectionA: string;
  let sectionB: string;
  let predefinedSections: Awaited<ReturnType<typeof kit.masters>>;
  let anna: SchoolStaff;
  let eve: SchoolStaff;
  let dev: SchoolStaff;
  let annaToken: string;
  let eveToken: string;
  let devToken: string;
  let parentToken: string;
  let guardianEmail: string;
  let predefinedClass: string;
  let otherPredefinedClass: string;
  let enrolments: Record<string, string>;
  let studentIds: Record<string, string>;
  let enrolmentOfB: string;

  const submission = (fields: object = {}) => ({
    sectionId: sectionA,
    attendanceDate: TODAY,
    rosterCount: 3,
    exceptions: [{ studentEnrolmentId: enrolments.bea, attendanceStatus: 2 }],
    ...fields,
  });
  const submit = (fields: object = {}, token = owner.token, key: string | null = newId()) => {
    let req = request(t.app.getHttpServer())
      .post('/v1/attendance/sessions')
      .set('Authorization', `Bearer ${token}`);
    if (key !== null) req = req.set('Idempotency-Key', key);
    return req.send(submission(fields));
  };
  const submitted = async (fields: object = {}, token = owner.token) => {
    const res = await submit(fields, token);
    expect([res.status, res.body.code]).toEqual([201, 'ATTENDANCE_SUBMITTED']);
    return res.body.data as Session;
  };
  const roster = async (sectionId: string, date: string, token = owner.token) => {
    const res = await api(
      'get',
      `/v1/attendance/roster?sectionId=${sectionId}&date=${date}`,
      token,
    );
    expect(res.status).toBe(200);
    return res.body as unknown as { data: Roster };
  };
  const drain = async () => {
    while (await runner.runNext()) {
      // the worker drains the queue
    }
  };
  const holiday = async (fields: object = {}) =>
    succeeded(
      await api('post', '/v1/events', owner.token, {
        title: 'Founders Day',
        startDate: TODAY,
        endDate: TODAY,
        durationLabel: '1 Day',
        scope: 1,
        isHoliday: true,
        holidayType: 1,
        holidayForStudents: true,
        ...fields,
      }),
      201,
      'holiday',
    );
  const tenant = { societyId: '', institutionIds: [] as string[], roleCode: 2, personId: '' };
  const rows = <T>(query: string, institutionIds = [first]) =>
    database.transaction(
      { ...tenant, societyId: societyA, institutionIds, personId: owner.person },
      async (tx) => (await sql<T>`${sql.raw(query)}`.execute(tx)).rows,
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
    runner = t.app.get(JobRunner);
    vi.spyOn(t.app.get(PushSender, { strict: false }), 'send').mockImplementation((messages) =>
      Promise.resolve(messages.map(() => 'sent' as const)),
    );
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    t.clock.set(`${TODAY}T01:00:00.000Z`);
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    const categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    const predefinedClasses = await kit.masters(admin, 'predefined-classes');
    predefinedClass = predefinedClasses.find((c) => c.code === 'C10')!.id;
    otherPredefinedClass = predefinedClasses.find((c) => c.code === 'C09')!.id;
    predefinedSections = await kit.masters(admin, 'predefined-sections');
    societyA = await kit.society(admin);
    owner = await fixtures.owner(societyA);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    year = await kit.year(owner.token, first);
    await kit.year(owner.token, second);
    firstAdmin = await fixtures.institutionAdmin(societyA, [first]);
    secondAdmin = await fixtures.institutionAdmin(societyA, [second]);
    otherOwner = await fixtures.owner(await kit.society(admin));
    classId = await kit.klass(owner.token, first, predefinedClass);
    sectionA = await kit.section(
      owner.token,
      classId,
      predefinedSections.find((s) => s.code === 'A')!.id,
    );
    sectionB = await kit.section(
      owner.token,
      classId,
      predefinedSections.find((s) => s.code === 'B')!.id,
    );
    const person = (name: string, home = first) =>
      kit.staff(owner.token, home, categoryId, { firstName: name, lastName: 'Rao' });
    anna = await person('Anna');
    eve = await person('Eve', second);
    dev = await person('Dev', second);
    succeeded(
      await api('put', `/v1/staff/${eve.id}/institutions`, owner.token, {
        institutionIds: [first],
      }),
      200,
      'extra Institution',
    );
    annaToken = await kit.actingAs(anna.person.email, TEACHER, societyA);
    eveToken = await kit.actingAs(eve.person.email, TEACHER, societyA);
    devToken = await kit.actingAs(dev.person.email, TEACHER, societyA);
    guardianEmail = parentEmail();
    const place = (sectionId: string) => ({ academicYearId: year, classId, sectionId });
    const named = async (firstName: string, sectionId: string, fields: object = {}) =>
      (await kit.student(owner.token, first, place(sectionId), { firstName, ...fields })).id;
    studentIds = {
      asha: await named('Asha', sectionA),
      bea: await named('Bea', sectionA, { guardians: [guardianOf(guardianEmail)] }),
      cy: await named('Cy', sectionA),
      dan: await named('Dan', sectionB),
    };
    const shown = (await roster(sectionA, TODAY)).data.students;
    enrolments = Object.fromEntries(
      shown.map((s) => [s.firstName.toLowerCase(), s.studentEnrolmentId]),
    );
    enrolmentOfB = (await roster(sectionB, TODAY)).data.students[0]!.studentEnrolmentId;
    // The roll numbers the kit gives are random; these put the children in the order of their names.
    for (const [name, roll] of [
      ['asha', '1'],
      ['bea', '2'],
      ['cy', '3'],
      ['dan', '1'],
    ] as const) {
      await rows(
        `update student_section_placements set roll_number = '${roll}' where student_enrolment_id = '${name === 'dan' ? enrolmentOfB : enrolments[name]!}'`,
      );
    }
    parentToken = (await signInMobile(t, guardianEmail)).accessToken;
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('ATT-01 the roster', () => {
    it('lists the section by roll number, everyone Present, and lets the Owner, the Admin and a teacher at home mark', async () => {
      const { data } = await roster(sectionA, TODAY);
      expect(data).toMatchObject({
        section: { id: sectionA, displayName: 'A', className: '10th' },
        date: TODAY,
        isHoliday: false,
        holidayTitle: null,
        canMark: true,
        existingSession: null,
      });
      expect(data.students.map((s) => s.firstName)).toEqual(['Asha', 'Bea', 'Cy']);
      expect(data.students.map((s) => s.attendanceStatus)).toEqual([1, 1, 1]);
      expect((await roster(sectionA, TODAY, firstAdmin.token)).data.canMark).toBe(true);
      expect((await roster(sectionA, TODAY, annaToken)).data.canMark).toBe(true);
      expect((await roster(sectionB, TODAY)).data.students.map((s) => s.firstName)).toEqual([
        'Dan',
      ]);
    });

    it('shows a teacher at an extra Institution the roster but not the Confirm button', async () => {
      expect((await roster(sectionA, TODAY, eveToken)).data.canMark).toBe(false);
    });

    it('is 404 for a section out of reach, and 403 for a parent', async () => {
      for (const token of [secondAdmin.token, otherOwner.token, devToken]) {
        expect(
          (await api('get', `/v1/attendance/roster?sectionId=${sectionA}&date=${TODAY}`, token))
            .status,
        ).toBe(404);
      }
      expect(
        (await api('get', `/v1/attendance/roster?sectionId=${sectionA}&date=${TODAY}`, parentToken))
          .status,
      ).toBe(403);
    });

    it('refuses a missing or a made-up date or section, naming the field', async () => {
      const res = await api(
        'get',
        '/v1/attendance/roster?sectionId=nope&date=2026-02-30',
        owner.token,
      );
      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual({ sectionId: 'INVALID_FORMAT', date: 'INVALID_FORMAT' });
    });

    it('still loads a day that has not come or is outside the year, and cannot mark it', async () => {
      expect((await roster(sectionA, '2026-11-18')).data.canMark).toBe(false);
      expect((await roster(sectionA, '2026-05-30')).data.canMark).toBe(false);
    });

    it('leaves out a child placed after the day', async () => {
      const { data } = await roster(sectionA, YESTERDAY);
      expect(data.students).toEqual([]);
      await rows(
        `update student_section_placements set start_date = '${YESTERDAY}' where section_id = '${sectionA}'`,
      );
      expect((await roster(sectionA, YESTERDAY)).data.students).toHaveLength(3);
    });

    it('names a holiday of the day, for the class it covers, and not for another class', async () => {
      await holiday({ holidayPredefinedClassIds: [otherPredefinedClass] });
      expect(await roster(sectionA, TODAY)).toMatchObject({
        data: { isHoliday: false, canMark: true },
      });
      await holiday({ title: 'Teachers Day', holidayPredefinedClassIds: [predefinedClass] });
      expect(await roster(sectionA, TODAY)).toMatchObject({
        data: { isHoliday: true, holidayTitle: 'Teachers Day', canMark: false },
      });
    });

    it('is not a holiday when the holiday is for the staff only', async () => {
      await holiday({ holidayForStudents: false, holidayForStaff: true });
      expect((await roster(sectionA, TODAY)).data).toMatchObject({
        isHoliday: false,
        canMark: true,
      });
    });

    it('is 422 CURRENT_YEAR_REQUIRED for an Institution with no current year', async () => {
      await rows(`update academic_years set is_current = false where institution_id = '${first}'`);
      const res = await api(
        'get',
        `/v1/attendance/roster?sectionId=${sectionA}&date=${TODAY}`,
        owner.token,
      );
      expect([res.status, res.body.code]).toEqual([422, 'CURRENT_YEAR_REQUIRED']);
    });
  });

  describe('ATT-02 submit', () => {
    it('stores the session with its counts, the marks and the audit entry, as the Owner, the Admin and a teacher at home', async () => {
      const asOwner = await submitted({
        exceptions: [
          { studentEnrolmentId: enrolments.asha, attendanceStatus: 2 },
          { studentEnrolmentId: enrolments.bea, attendanceStatus: 3 },
          { studentEnrolmentId: enrolments.cy, attendanceStatus: 5 },
        ],
      });
      expect(asOwner).toMatchObject({
        sectionName: 'A',
        className: '10th',
        attendanceDate: TODAY,
        rosterCount: 3,
        presentCount: 0,
        absentCount: 1,
        lateCount: 1,
        halfDayCount: 0,
        leaveCount: 1,
        submittedBy: { id: owner.person },
      });
      const stored = await rows<{
        roster_count: number;
        present_count: number;
        attendance_mode: number;
        time_slot_id: string | null;
        taken_by_staff_member_id: string | null;
      }>(`select * from attendance_sessions where id = '${asOwner.id}'`);
      expect(stored[0]).toMatchObject({
        roster_count: 3,
        present_count: 0,
        attendance_mode: 2,
        time_slot_id: null,
        taken_by_staff_member_id: null,
      });
      expect(
        await rows(
          `select student_enrolment_id, attendance_status from attendance_exceptions where attendance_session_id = '${asOwner.id}' order by attendance_status`,
        ),
      ).toEqual([
        { student_enrolment_id: enrolments.asha, attendance_status: 2 },
        { student_enrolment_id: enrolments.bea, attendance_status: 3 },
        { student_enrolment_id: enrolments.cy, attendance_status: 5 },
      ]);
      const entries = await readAuditRows<{ action: string; institution_id: string | null }>(
        ownerDb,
        sql`entity_id = ${asOwner.id}`,
      );
      expect(entries).toMatchObject([{ action: 'attendance.submitted', institution_id: first }]);

      const byAdmin = await submitted(
        { sectionId: sectionB, rosterCount: 1, exceptions: [] },
        firstAdmin.token,
      );
      expect(byAdmin).toMatchObject({
        rosterCount: 1,
        presentCount: 1,
        submittedBy: { id: firstAdmin.person },
      });
      const byTeacher = await submitted(
        { attendanceDate: YESTERDAY, exceptions: [], rosterCount: 0 },
        annaToken,
      );
      expect(byTeacher.rosterCount).toBe(0);
      expect(
        (
          await rows<{ taken_by_staff_member_id: string | null }>(
            `select taken_by_staff_member_id from attendance_sessions where id = '${byTeacher.id}'`,
          )
        )[0]!.taken_by_staff_member_id,
      ).toBe(anna.id);
    });

    it('says how many students, and shows the marks on the roster and in ATT-04 afterwards', async () => {
      const res = await submit();
      expect(res.body).toMatchObject({
        code: 'ATTENDANCE_SUBMITTED',
        message: 'Attendance submitted for 3 students',
      });
      const session = res.body.data as unknown as Session;
      const { data } = await roster(sectionA, TODAY);
      expect(data.canMark).toBe(false);
      expect(data.existingSession).toMatchObject({ id: session.id, version: 1 });
      expect(data.students.map((s) => s.attendanceStatus)).toEqual([1, 2, 1]);
      const detail = await api('get', `/v1/attendance/sessions/${session.id}`, firstAdmin.token);
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({
        id: session.id,
        absentCount: 1,
        marks: [{ studentEnrolmentId: enrolments.bea, firstName: 'Bea', attendanceStatus: 2 }],
      });
    });

    it('gives the same answer for the same key and body, and refuses the key for another body', async () => {
      const key = newId();
      const one = await submit({}, owner.token, key);
      const again = await submit({}, owner.token, key);
      expect([again.status, again.body.code, again.headers['idempotent-replayed']]).toEqual([
        201,
        'ATTENDANCE_SUBMITTED',
        'true',
      ]);
      expect(again.body.data.id).toBe(one.body.data.id);
      const other = await submit({ exceptions: [] }, owner.token, key);
      expect([other.status, other.body.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
      expect(
        await rows(`select 1 from attendance_sessions where section_id = '${sectionA}'`),
      ).toHaveLength(1);
    });

    it('needs an Idempotency-Key', async () => {
      const res = await submit({}, owner.token, null);
      expect([res.status, res.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    });

    it('refuses a second submission with the first one’s ID (409 ATTENDANCE_ALREADY_SUBMITTED)', async () => {
      const kept = await submitted();
      const again = await submit({ exceptions: [] });
      expect([again.status, again.body.code]).toEqual([409, 'ATTENDANCE_ALREADY_SUBMITTED']);
      expect(again.body.data).toEqual({ sessionId: kept.id });
    });

    it('lets only one of two submissions at once in, and names the winner to the other', async () => {
      const [a, b] = await Promise.all([
        submit({}, owner.token),
        submit({ exceptions: [] }, firstAdmin.token),
      ]);
      const won = [a, b].find((r) => r.status === 201)!;
      const lost = [a, b].find((r) => r.status === 409)!;
      expect([won.status, lost.status]).toEqual([201, 409]);
      expect(lost.body.code).toBe('ATTENDANCE_ALREADY_SUBMITTED');
      expect(lost.body.data).toEqual({ sessionId: won.body.data.id });
      expect(
        await rows(`select 1 from attendance_sessions where section_id = '${sectionA}'`),
      ).toHaveLength(1);
    });

    it('allows another day, and another section of the same day', async () => {
      await submitted();
      await submitted({ attendanceDate: YESTERDAY, exceptions: [], rosterCount: 0 });
      await submitted({ sectionId: sectionB, rosterCount: 1, exceptions: [] });
    });

    it('refuses a roster that changed since the screen loaded, naming the count (409 ROSTER_CHANGED)', async () => {
      const res = await submit({ rosterCount: 4 });
      expect([res.status, res.body.code]).toEqual([409, 'ROSTER_CHANGED']);
      expect(res.body.data).toEqual({ rosterCount: 3 });
      expect(
        await rows(`select 1 from attendance_sessions where section_id = '${sectionA}'`),
      ).toHaveLength(0);
    });

    it('refuses a student who is not in the section on the day (422 STUDENT_NOT_IN_SECTION), writing nothing', async () => {
      const res = await submit({
        exceptions: [
          { studentEnrolmentId: enrolments.asha, attendanceStatus: 3 },
          { studentEnrolmentId: enrolmentOfB, attendanceStatus: 2 },
        ],
      });
      expect([res.status, res.body.code]).toEqual([422, 'STUDENT_NOT_IN_SECTION']);
      expect(fieldsOf(res)).toEqual({
        'exceptions[1].studentEnrolmentId': 'STUDENT_NOT_IN_SECTION',
      });
      const unknown = await submit({
        exceptions: [{ studentEnrolmentId: newId(), attendanceStatus: 2 }],
      });
      expect(unknown.body.code).toBe('STUDENT_NOT_IN_SECTION');
      expect(await rows('select 1 from attendance_exceptions')).toHaveLength(0);
    });

    it('refuses a child who left before the day, and one placed after it', async () => {
      await rows(
        `update student_enrolments set enrolled_date = '2026-06-01', left_date = '${YESTERDAY}' where id = '${enrolments.cy}'`,
      );
      expect((await submit({ rosterCount: 3 })).body.code).toBe('ROSTER_CHANGED');
      const res = await submit({
        rosterCount: 2,
        exceptions: [{ studentEnrolmentId: enrolments.cy, attendanceStatus: 2 }],
      });
      expect([res.status, res.body.code]).toEqual([422, 'STUDENT_NOT_IN_SECTION']);
    });

    it('refuses a day that has not come, and a day outside the current year (422)', async () => {
      const future = await submit({ attendanceDate: '2026-11-18' });
      expect([future.status, future.body.code]).toEqual([422, 'DATE_IN_FUTURE']);
      const outside = await submit({ attendanceDate: '2026-05-30' });
      expect([outside.status, outside.body.code]).toEqual([422, 'DATE_OUTSIDE_CURRENT_YEAR']);
    });

    it('refuses a holiday of the section’s class (422 DATE_IS_HOLIDAY), and takes another class’s holiday', async () => {
      await holiday({ holidayPredefinedClassIds: [otherPredefinedClass] });
      await submitted();
      await holiday({ title: 'Teachers Day', holidayPredefinedClassIds: [predefinedClass] });
      const res = await submit({ sectionId: sectionB, rosterCount: 1, exceptions: [] });
      expect([res.status, res.body.code]).toEqual([422, 'DATE_IS_HOLIDAY']);
    });

    it('lets a teacher mark only at their home Institution (403 NOT_ASSIGNED), and 404 beyond their reach', async () => {
      const away = await submit({}, eveToken);
      expect([away.status, away.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      expect((await submit({}, devToken)).status).toBe(404);
      expect((await submit({}, secondAdmin.token)).status).toBe(404);
      expect((await submit({}, otherOwner.token)).status).toBe(404);
      expect((await submit({}, parentToken)).status).toBe(403);
      expect(await rows('select 1 from attendance_sessions')).toHaveLength(0);
    });

    it('refuses a deactivated section (422 REFERENCE_INACTIVE)', async () => {
      const empty = await kit.section(
        owner.token,
        classId,
        predefinedSections.find((s) => s.code === 'C')!.id,
      );
      succeeded(await api('delete', `/v1/sections/${empty}`, owner.token), 200, 'section');
      const res = await submit({ sectionId: empty, rosterCount: 0, exceptions: [] });
      expect([res.status, res.body.code]).toEqual([422, 'REFERENCE_INACTIVE']);
      expect(fieldsOf(res)).toEqual({ sectionId: 'REFERENCE_INACTIVE' });
    });

    it('checks the body, naming each field that is wrong', async () => {
      const res = await submit({
        attendanceDate: 'today',
        rosterCount: '3',
        exceptions: [
          { studentEnrolmentId: enrolments.asha, attendanceStatus: 1 },
          { studentEnrolmentId: enrolments.asha, attendanceStatus: 2 },
        ],
        timeSlotId: newId(),
      });
      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toMatchObject({
        attendanceDate: 'INVALID_FORMAT',
        rosterCount: 'INVALID_TYPE',
        'exceptions[0].attendanceStatus': 'INVALID_CODE',
        timeSlotId: 'FIELD_NOT_ALLOWED',
      });
      const twice = await submit({
        exceptions: [
          { studentEnrolmentId: enrolments.asha, attendanceStatus: 3 },
          { studentEnrolmentId: enrolments.asha, attendanceStatus: 2 },
        ],
      });
      expect(twice.status).toBe(400);
      expect(fieldsOf(twice)).toEqual({ 'exceptions[1].studentEnrolmentId': 'INVALID_VALUE' });
    });

    it('alerts the guardians of an Absent student, once, in their inbox, and no one for Late', async () => {
      const session = await submitted({
        exceptions: [
          { studentEnrolmentId: enrolments.bea, attendanceStatus: 2 },
          { studentEnrolmentId: enrolments.cy, attendanceStatus: 3 },
        ],
      });
      const jobs = await readJobs(ownerDb, societyA, 'notify');
      expect(jobs.map((job) => (job.payload as { sourceKey: string }).sourceKey)).toEqual([
        `absent:${session.id}:${enrolments.bea}`,
      ]);
      await drain();
      await drain();
      const inbox = await api('get', '/v1/notifications?tab=1&limit=50', parentToken);
      expect(inbox.status).toBe(200);
      expect(inbox.body.data).toEqual([
        expect.objectContaining({
          title: 'Marked absent',
          body: 'Bea was marked absent on 17 Nov 2026.',
          category: 1,
          studentId: studentIds.bea,
        }),
      ]);
    });
  });

  describe('ATT-03 and ATT-04 reading sessions', () => {
    it('lists a section’s sessions, or an Institution’s, on a day, and reads one with its marks', async () => {
      const a = await submitted();
      const b = await submitted({ sectionId: sectionB, rosterCount: 1, exceptions: [] });
      await submitted({ attendanceDate: YESTERDAY, rosterCount: 0, exceptions: [] });
      const bySection = await api(
        'get',
        `/v1/attendance/sessions?date=${TODAY}&sectionId=${sectionA}`,
        annaToken,
      );
      expect(bySection.body.data).toMatchObject([{ id: a.id, sectionName: 'A', absentCount: 1 }]);
      expect(bySection.body.meta).toBeNull();
      const byInstitution = await api(
        'get',
        `/v1/attendance/sessions?date=${TODAY}&institutionId=${first}`,
        firstAdmin.token,
      );
      expect((byInstitution.body.data as unknown as Session[]).map((s) => s.id)).toEqual([
        a.id,
        b.id,
      ]);
      const empty = await api(
        'get',
        `/v1/attendance/sessions?date=2026-11-15&institutionId=${first}`,
        owner.token,
      );
      expect(empty.body.data).toEqual([]);
    });

    it('needs a section or an Institution, and not both', async () => {
      const none = await api('get', `/v1/attendance/sessions?date=${TODAY}`, owner.token);
      expect([none.status, fieldsOf(none)]).toEqual([400, { institutionId: 'REQUIRED' }]);
      const both = await api(
        'get',
        `/v1/attendance/sessions?date=${TODAY}&sectionId=${sectionA}&institutionId=${first}`,
        owner.token,
      );
      expect([both.status, fieldsOf(both)]).toEqual([400, { institutionId: 'FIELD_NOT_ALLOWED' }]);
    });

    it('shows other Institutions, other Societies and parents nothing', async () => {
      const made = await submitted();
      for (const token of [secondAdmin.token, otherOwner.token, devToken]) {
        expect(
          (await api('get', `/v1/attendance/sessions?date=${TODAY}&institutionId=${first}`, token))
            .status,
        ).toBe(404);
        expect((await api('get', `/v1/attendance/sessions/${made.id}`, token)).status).toBe(404);
      }
      expect((await api('get', `/v1/attendance/sessions/${made.id}`, parentToken)).status).toBe(
        403,
      );
      expect((await api('get', `/v1/attendance/sessions/${newId()}`, owner.token)).status).toBe(
        404,
      );
    });

    it('lets a teacher at an extra Institution read, and not a void session', async () => {
      const made = await submitted();
      expect((await api('get', `/v1/attendance/sessions/${made.id}`, eveToken)).status).toBe(200);
      await rows(`update attendance_sessions set status = 0 where id = '${made.id}'`);
      expect((await api('get', `/v1/attendance/sessions/${made.id}`, owner.token)).status).toBe(
        404,
      );
      const sessions = await api(
        'get',
        `/v1/attendance/sessions?date=${TODAY}&sectionId=${sectionA}`,
        owner.token,
      );
      expect(sessions.body.data).toEqual([]);
      await submitted();
    });
  });

  describe('the roster rule (DDD 13.2)', () => {
    it('leaves out a child whose placement was made after the session was submitted', async () => {
      const roll = t.app.get(SectionRoster);
      const onThen = (cutOff: Date) =>
        database.transaction(
          { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
          async (tx) => (await roll.on(tx, sectionA, TODAY, cutOff)).map((s) => s.firstName),
        );
      expect(await onThen(new Date(Date.now() - 86_400_000))).toEqual([]);
      expect(await onThen(new Date(Date.now() + 86_400_000))).toEqual(['Asha', 'Bea', 'Cy']);
    });
  });

  describe('the tables', () => {
    it('keeps the counts, the mode and the key of an exception right, and cannot be deleted by the app role', async () => {
      const made = await submitted();
      const bad = (set: string) =>
        rows(`update attendance_sessions set ${set} where id = '${made.id}'`);
      await expect(bad('absent_count = 9')).rejects.toMatchObject({ code: '23514' });
      await expect(bad('late_count = -1')).rejects.toMatchObject({ code: '23514' });
      await expect(bad('attendance_mode = 1')).rejects.toMatchObject({ code: '23514' });
      await expect(bad('attendance_mode = 3')).rejects.toMatchObject({ code: '23514' });
      await expect(
        rows(`delete from attendance_sessions where id = '${made.id}'`),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        rows(
          `insert into attendance_exceptions (attendance_session_id, student_enrolment_id, attendance_date, institution_id, attendance_status) values ('${made.id}', '${enrolments.asha}', '${TODAY}', '${first}', 1)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        rows(
          `insert into attendance_exceptions (attendance_session_id, student_enrolment_id, attendance_date, institution_id, attendance_status) values ('${made.id}', '${enrolments.bea}', '${TODAY}', '${first}', 3)`,
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        rows(
          `insert into attendance_exceptions (attendance_session_id, student_enrolment_id, attendance_date, institution_id, attendance_status) values ('${made.id}', '${enrolments.asha}', '${YESTERDAY}', '${first}', 3)`,
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(rows(`delete from attendance_exceptions`)).rejects.toMatchObject({
        code: '42501',
      });
    });

    it('shows an Institution’s sessions and marks to its own scope only', async () => {
      await submitted();
      expect(await rows('select 1 from attendance_sessions', [second])).toEqual([]);
      expect(await rows('select 1 from attendance_exceptions', [second])).toEqual([]);
      expect(await rows('select 1 from attendance_exceptions', [first])).toHaveLength(1);
      await expect(
        rows(
          `insert into attendance_sessions (society_id, institution_id, academic_year_id, section_id, attendance_date, roster_count, submitted_by) values ('${societyA}', '${second}', '${year}', '${sectionA}', '${TODAY}', 0, '${owner.person}')`,
          [first],
        ),
      ).rejects.toThrow();
    });

    it('gives the app role no right on a partition addressed by name', async () => {
      await submitted();
      await expect(rows('select 1 from attendance_exceptions_2026')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(rows('select 1 from attendance_exceptions_default')).rejects.toMatchObject({
        code: '42501',
      });
    });

    it('keeps the DEFAULT partition empty while the year’s partition exists', async () => {
      await submitted();
      expect(
        (await ownerRows(`select count(*)::int as n from only attendance_exceptions_default`))[0],
      ).toEqual({ n: 0 });
    });

    it('makes the yearly partitions on call, only for the years asked, and refuses a silly range', async () => {
      const made = await rows<{ made: number }>(
        `select maintenance.ensure_attendance_partitions(2090, 1) as made`,
      );
      expect(made[0]!.made).toBe(2);
      expect(
        (
          await rows<{ made: number }>(
            `select maintenance.ensure_attendance_partitions(2090, 1) as made`,
          )
        )[0]!.made,
      ).toBe(0);
      await expect(
        rows(`select maintenance.ensure_attendance_partitions(1999, 0)`),
      ).rejects.toThrow(/first_year/);
      await expect(
        rows(`select maintenance.ensure_attendance_partitions(2026, 9)`),
      ).rejects.toThrow(/years_ahead/);
      await sql`drop table attendance_exceptions_2090, attendance_exceptions_2091`.execute(ownerDb);
    });
  });

  /** A read as the table owner, who is not bound by the policies. */
  const ownerRows = async (query: string) =>
    (await sql<Record<string, unknown>>`${sql.raw(query)}`.execute(ownerDb)).rows;
});
