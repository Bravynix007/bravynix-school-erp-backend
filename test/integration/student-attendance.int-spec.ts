import { sql, Kysely, PostgresDialect } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { PushSender } from '../../src/platform/notifications/index.js';
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
const PARENT = 5;
const TODAY = '2026-11-17';
/** The first day the children sit in section A: the roll of the days before it did not have them. */
const JOINED = '2026-11-02';

interface Day {
  date: string;
  dayStatus: string;
  isWeekend: boolean;
  holidayTitle: string | null;
}
interface Calendar {
  month: string;
  summary: Record<string, number | null>;
  yearToDate: { attendancePercentage: number | null };
  days: Day[];
}
interface DayDetail extends Day {
  section: { id: string; name: string | null; className: string | null } | null;
  markedBy: { id: string; displayName: string } | null;
  markedAt: string | null;
  lastCorrectedAt: string | null;
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

const statuses = (calendar: Calendar, from: string, to: string) =>
  calendar.days.filter((d) => d.date >= from && d.date <= to).map((d) => d.dayStatus);

describe('ATT-07 and ATT-08 a student’s attendance (API design 10.13)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;

  let societyA: string;
  let first: string;
  let second: string;
  let year: string;
  let classId: string;
  let sectionA: string;
  let sectionB: string;
  let owner: SignedInPerson;
  let firstAdmin: SignedInPerson;
  let secondAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let anna: SchoolStaff;
  let eve: SchoolStaff;
  let dev: SchoolStaff;
  let annaToken: string;
  let eveToken: string;
  let devToken: string;
  let beaParent: string;
  let danParent: string;
  let studentIds: Record<string, string>;
  let enrolments: Record<string, string>;

  const rows = <T>(query: string) =>
    database.transaction(
      {
        societyId: societyA,
        institutionIds: [first],
        roleCode: 2,
        personId: owner.person,
      },
      async (tx) => (await sql<T>`${sql.raw(query)}`.execute(tx)).rows,
    );
  const asParent = <T>(childIds: string[], query: string) =>
    database.transaction(
      { personId: newId(), roleCode: PARENT, childIds },
      async (tx) => (await sql<T>`${sql.raw(query)}`.execute(tx)).rows,
    );
  const submit = async (
    date: string,
    exceptions: [string, number][] = [],
    sectionId = sectionA,
    rosterCount = 3,
  ) => {
    const res = await request(t.app.getHttpServer())
      .post('/v1/attendance/sessions')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', newId())
      .send({
        sectionId,
        attendanceDate: date,
        rosterCount,
        exceptions: exceptions.map(([name, attendanceStatus]) => ({
          studentEnrolmentId: enrolments[name]!,
          attendanceStatus,
        })),
      });
    expect([res.status, res.body.code]).toEqual([201, 'ATTENDANCE_SUBMITTED']);
    return res.body.data as { id: string };
  };
  const month = (studentId: string, value: string, token = owner.token) =>
    api('get', `/v1/students/${studentId}/attendance?month=${value}`, token);
  const calendarOf = async (name: string, value = '2026-11', token = owner.token) => {
    const res = await month(studentIds[name]!, value, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Calendar;
  };
  const day = (studentId: string, date: string, token = owner.token) =>
    api('get', `/v1/students/${studentId}/attendance/days/${date}`, token);
  const dayOf = async (name: string, date: string, token = owner.token) => {
    const res = await day(studentIds[name]!, date, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as DayDetail;
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
    const predefinedClass = (await kit.masters(admin, 'predefined-classes')).find(
      (c) => c.code === 'C10',
    )!.id;
    const predefinedSections = await kit.masters(admin, 'predefined-sections');
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
    const sectionOf = (code: string) =>
      kit.section(owner.token, classId, predefinedSections.find((s) => s.code === code)!.id);
    sectionA = await sectionOf('A');
    sectionB = await sectionOf('B');
    const person = (name: string, home = first) =>
      kit.staff(owner.token, home, categoryId, { firstName: name, lastName: 'Rao' });
    anna = await person('Anna');
    eve = await person('Eve');
    dev = await person('Dev', second);
    // Anna leads section A; Eve leads section B, so Section A's children are not hers to read.
    for (const [staff, sectionId] of [
      [anna, sectionA],
      [eve, sectionB],
    ] as const) {
      succeeded(
        await api('put', `/v1/staff/${staff.id}/class-teacher`, owner.token, {
          academicYearId: year,
          sectionId,
        }),
        200,
        'class teacher',
      );
    }
    annaToken = await kit.actingAs(anna.person.email, TEACHER, societyA);
    eveToken = await kit.actingAs(eve.person.email, TEACHER, societyA);
    devToken = await kit.actingAs(dev.person.email, TEACHER, societyA);
    const beaEmail = parentEmail();
    const danEmail = parentEmail();
    const named = async (firstName: string, sectionId: string, fields: object = {}) =>
      (
        await kit.student(
          owner.token,
          first,
          { academicYearId: year, classId, sectionId },
          { firstName, ...fields },
        )
      ).id;
    studentIds = {
      asha: await named('Asha', sectionA),
      bea: await named('Bea', sectionA, { guardians: [guardianOf(beaEmail)] }),
      cy: await named('Cy', sectionA),
      dan: await named('Dan', sectionB, { guardians: [guardianOf(danEmail)] }),
    };
    await rows(
      `update student_section_placements set start_date = '${JOINED}' where section_id in ('${sectionA}', '${sectionB}')`,
    );
    const roster = async (sectionId: string) => {
      const res = await api(
        'get',
        `/v1/attendance/roster?sectionId=${sectionId}&date=${TODAY}`,
        owner.token,
      );
      expect(res.status).toBe(200);
      return res.body.data as unknown as {
        students: { firstName: string; studentEnrolmentId: string }[];
      };
    };
    enrolments = Object.fromEntries(
      [...(await roster(sectionA)).students, ...(await roster(sectionB)).students].map((s) => [
        s.firstName.toLowerCase(),
        s.studentEnrolmentId,
      ]),
    );
    beaParent = (await signInMobile(t, beaEmail)).accessToken;
    danParent = (await signInMobile(t, danEmail)).accessToken;
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  /** Section A on seven days of the month: Bea is Absent, Late, Half day and on Leave, then Present twice. */
  const markMonth = async () => {
    const sessions: Record<string, string> = {};
    for (const [date, exceptions] of [
      ['2026-11-03', [['bea', 2]]],
      ['2026-11-04', [['bea', 3]]],
      ['2026-11-05', [['bea', 4]]],
      ['2026-11-06', [['bea', 5]]],
      ['2026-11-10', []],
      ['2026-11-12', [['cy', 2]]],
    ] as [string, [string, number][]][]) {
      sessions[date] = (await submit(date, exceptions)).id;
    }
    return sessions;
  };
  const holiday = async (startDate: string, endDate: string, fields: object = {}) =>
    succeeded(
      await api('post', '/v1/events', owner.token, {
        title: 'Founders Day',
        startDate,
        endDate,
        durationLabel: 'Days',
        scope: 1,
        isHoliday: true,
        holidayType: 1,
        holidayForStudents: true,
        ...fields,
      }),
      201,
      'holiday',
    );

  describe('ATT-07 the month', () => {
    it('tells each day from the sessions and exceptions, counts them and gives the percentage', async () => {
      await markMonth();
      await holiday('2026-11-11', '2026-11-11');
      const bea = await calendarOf('bea');
      expect(bea.month).toBe('2026-11');
      expect(bea.days).toHaveLength(30);
      expect(statuses(bea, '2026-11-01', '2026-11-17')).toEqual([
        'not_enrolled', // 1 Sun, before the placement
        'not_marked', // 2 Mon, a school day nobody marked
        'absent',
        'late',
        'half_day',
        'leave',
        'not_marked', // 7 Sat
        'not_marked', // 8 Sun
        'not_marked', // 9 Mon
        'present',
        'holiday',
        'present', // 12: a session was taken and Bea is not an exception in it
        'not_marked',
        'not_marked',
        'not_marked',
        'not_marked',
        'not_marked', // 17, today
      ]);
      expect(bea.days.find((d) => d.date === '2026-11-11')).toMatchObject({
        dayStatus: 'holiday',
        holidayTitle: 'Founders Day',
      });
      expect(bea.days.find((d) => d.date === '2026-11-08')).toMatchObject({
        isWeekend: true,
      });
      expect(bea.summary).toEqual({
        presentDays: 2,
        absentDays: 1,
        lateDays: 1,
        halfDays: 1,
        leaveDays: 1,
        holidays: 1,
        notMarkedDays: 7,
        attendancePercentage: 58.33,
      });
      expect(bea.yearToDate.attendancePercentage).toBe(58.33);
    });

    it('counts the days still to come as neither missing nor marked, and gives each child their own days', async () => {
      await markMonth();
      const cy = await calendarOf('cy');
      expect(cy.summary).toMatchObject({
        presentDays: 5,
        absentDays: 1,
        attendancePercentage: 83.33,
      });
      expect(statuses(cy, '2026-11-18', '2026-11-30').every((s) => s === 'not_marked')).toBe(true);
      const asha = await calendarOf('asha');
      expect(asha.summary).toMatchObject({
        presentDays: 6,
        absentDays: 0,
        attendancePercentage: 100,
      });
    });

    it('has no percentage for a month with nothing marked, and shows a month still to come', async () => {
      const october = await calendarOf('bea', '2026-10');
      expect(october.days).toHaveLength(31);
      expect(new Set(october.days.map((d) => d.dayStatus))).toEqual(new Set(['not_enrolled']));
      expect(october.summary).toMatchObject({ notMarkedDays: 0, attendancePercentage: null });
      expect(october.yearToDate.attendancePercentage).toBeNull();
      const march = await calendarOf('bea', '2027-03');
      expect(march.days).toHaveLength(31);
      expect(new Set(march.days.map((d) => d.dayStatus))).toEqual(new Set(['not_marked']));
      expect(march.summary.notMarkedDays).toBe(0);
    });

    it('follows a correction and a void', async () => {
      const sessions = await markMonth();
      const corrected = await api(
        'patch',
        `/v1/attendance/sessions/${sessions['2026-11-03']}/marks`,
        owner.token,
        { version: 1, changes: [{ studentEnrolmentId: enrolments.bea, attendanceStatus: 1 }] },
      );
      expect(corrected.status).toBe(200);
      const voided = await api(
        'post',
        `/v1/attendance/sessions/${sessions['2026-11-10']}/void`,
        owner.token,
        { version: 1, reason: 'Taken for the wrong section' },
      );
      expect(voided.status).toBe(200);
      const bea = await calendarOf('bea');
      expect(statuses(bea, '2026-11-03', '2026-11-03')).toEqual(['present']);
      expect(statuses(bea, '2026-11-10', '2026-11-10')).toEqual(['not_marked']);
      expect(bea.summary).toMatchObject({ presentDays: 2, absentDays: 0 });
    });

    it('does not count a section’s session for a student placed after it was submitted', async () => {
      await markMonth();
      await rows(
        `update student_section_placements set created_at = '2099-01-01T00:00:00Z' where student_enrolment_id = '${enrolments.asha}'`,
      );
      const asha = await calendarOf('asha');
      expect(new Set(statuses(asha, '2026-11-03', '2026-11-12'))).toEqual(new Set(['not_marked']));
      expect(asha.summary.attendancePercentage).toBeNull();
    });

    it('stops the days at the day a student left', async () => {
      await markMonth();
      await rows(
        `update student_enrolments set enrolled_date = '${JOINED}', left_date = '2026-11-05' where id = '${enrolments.cy}'`,
      );
      const cy = await calendarOf('cy');
      expect(statuses(cy, '2026-11-05', '2026-11-06')).toEqual(['present', 'not_enrolled']);
    });

    it('keeps a deactivated academic year from holding a month', async () => {
      const later = await kit.year(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-04-05',
        endDate: '2028-03-31',
      });
      expect((await month(studentIds.bea!, '2027-05')).status).toBe(200);
      succeeded(await api('delete', `/v1/academic-years/${later}`, owner.token), 200, 'deactivate');
      const res = await month(studentIds.bea!, '2027-05');
      expect([res.status, res.body.code]).toEqual([422, 'OUTSIDE_ACADEMIC_YEAR']);
    });

    it('reads a month two years share in the current one, not the one that begins later', async () => {
      await markMonth();
      await rows(`update academic_years set end_date = '2026-11-20' where id = '${year}'`);
      const alone = (await calendarOf('bea')).yearToDate.attendancePercentage;
      expect(alone).not.toBeNull();
      await kit.year(owner.token, first, {
        name: '2026-2027 B',
        startDate: '2026-11-25',
        endDate: '2027-03-31',
      });
      expect((await calendarOf('bea')).yearToDate.attendancePercentage).toBe(alone);
    });

    it('refuses a month outside every academic year (422) and a month written wrong (400)', async () => {
      for (const value of ['2026-05', '2027-04', '2025-01']) {
        const res = await month(studentIds.bea!, value);
        expect([res.status, res.body.code]).toEqual([422, 'OUTSIDE_ACADEMIC_YEAR']);
      }
      for (const value of ['2026-13', '2026-5', 'november']) {
        const res = await month(studentIds.bea!, value);
        expect([res.status, fieldsOf(res)]).toEqual([400, { month: 'INVALID_FORMAT' }]);
      }
      const empty = await month(studentIds.bea!, '');
      expect([empty.status, fieldsOf(empty)]).toEqual([400, { month: 'REQUIRED' }]);
      const missing = await api('get', `/v1/students/${studentIds.bea}/attendance`, owner.token);
      expect(missing.status).toBe(400);
      expect((await month('nope', '2026-11')).status).toBe(404);
    });
  });

  describe('a holiday limited to classes', () => {
    it('is told on a parent’s calendar as on the Owner’s, for the child’s class only (QA B8 D1)', async () => {
      const c10 = (await kit.masters(admin, 'predefined-classes')).find(
        (c) => c.code === 'C10',
      )!.id;
      const c9 = (await kit.masters(admin, 'predefined-classes')).find((c) => c.code === 'C09')!.id;
      await holiday('2026-11-11', '2026-11-11', {
        holidayType: 2,
        holidayPredefinedClassIds: [c10],
      });
      await holiday('2026-11-12', '2026-11-12', {
        title: 'Ninth only',
        holidayType: 2,
        holidayPredefinedClassIds: [c9],
      });
      for (const token of [owner.token, beaParent]) {
        const bea = await calendarOf('bea', '2026-11', token);
        expect(bea.days.find((d) => d.date === '2026-11-11')).toMatchObject({
          dayStatus: 'holiday',
          holidayTitle: 'Founders Day',
        });
        expect(bea.days.find((d) => d.date === '2026-11-12')).toMatchObject({
          dayStatus: 'not_marked',
          holidayTitle: null,
        });
      }
    });
  });

  describe('ATT-08 the day', () => {
    it('names the section, who marked it and when, and the correction', async () => {
      const sessions = await markMonth();
      t.clock.set(`${TODAY}T01:05:00.000Z`);
      await api('patch', `/v1/attendance/sessions/${sessions['2026-11-04']}/marks`, owner.token, {
        version: 1,
        changes: [{ studentEnrolmentId: enrolments.bea, attendanceStatus: 5 }],
      });
      const absent = await dayOf('bea', '2026-11-03');
      expect(absent).toMatchObject({
        date: '2026-11-03',
        dayStatus: 'absent',
        isWeekend: false,
        holidayTitle: null,
        section: { id: sectionA, name: 'A', className: '10th' },
        markedBy: { id: owner.person },
        markedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
        lastCorrectedAt: null,
      });
      expect(absent.markedBy?.displayName).toBeTruthy();
      // A parent cannot read the class, so the day keeps the section's id and leaves its names empty.
      expect(await dayOf('bea', '2026-11-03', beaParent)).toMatchObject({
        section: { id: sectionA, name: null, className: null },
      });
      expect(await dayOf('bea', '2026-11-04')).toMatchObject({
        dayStatus: 'leave',
        lastCorrectedAt: `${TODAY}T01:05:00.000Z`,
      });
    });

    it('answers a holiday, a day nobody marked and a day before the student joined', async () => {
      await holiday('2026-11-11', '2026-11-11');
      expect(await dayOf('bea', '2026-11-11')).toMatchObject({
        dayStatus: 'holiday',
        holidayTitle: 'Founders Day',
        markedBy: null,
        markedAt: null,
        section: { id: sectionA },
      });
      expect(await dayOf('bea', '2026-11-09')).toMatchObject({
        dayStatus: 'not_marked',
        markedBy: null,
      });
      expect(await dayOf('bea', '2026-11-08')).toMatchObject({
        dayStatus: 'not_marked',
        isWeekend: true,
      });
      expect(await dayOf('bea', '2026-11-01')).toMatchObject({
        dayStatus: 'not_enrolled',
        section: null,
        markedBy: null,
      });
    });

    it('refuses a day outside every year (422) and a date that is not a day (400)', async () => {
      const outside = await day(studentIds.bea!, '2027-05-01');
      expect([outside.status, outside.body.code]).toEqual([422, 'OUTSIDE_ACADEMIC_YEAR']);
      for (const date of ['2026-02-30', '2026-11-3', 'today']) {
        const res = await day(studentIds.bea!, date);
        expect([res.status, fieldsOf(res)]).toEqual([400, { date: 'INVALID_FORMAT' }]);
      }
    });
  });

  describe('who may read it', () => {
    it('lets an Owner, an Admin, the class teacher and the child’s own parent read both', async () => {
      await markMonth();
      for (const token of [owner.token, firstAdmin.token, annaToken, beaParent]) {
        expect((await month(studentIds.bea!, '2026-11', token)).status).toBe(200);
        expect((await day(studentIds.bea!, '2026-11-03', token)).status).toBe(200);
      }
    });

    it('is 403 NOT_ASSIGNED for a teacher of another section, and 404 out of reach', async () => {
      const away = await month(studentIds.bea!, '2026-11', eveToken);
      expect([away.status, away.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      const awayDay = await day(studentIds.bea!, '2026-11-03', eveToken);
      expect([awayDay.status, awayDay.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      for (const token of [secondAdmin.token, otherOwner.token, devToken]) {
        expect((await month(studentIds.bea!, '2026-11', token)).status).toBe(404);
        expect((await day(studentIds.bea!, '2026-11-03', token)).status).toBe(404);
      }
    });

    it('lets a parent read their own child only, and a Super Admin not at all', async () => {
      expect((await month(studentIds.dan!, '2026-11', beaParent)).status).toBe(404);
      expect((await day(studentIds.bea!, '2026-11-03', danParent)).status).toBe(404);
      expect((await month(studentIds.bea!, '2026-11', admin)).status).toBe(403);
    });
  });

  describe('what a parent can read of the tables (row-level security)', () => {
    it('sees the sessions of their child’s section and the marks against their child, and nothing else', async () => {
      await submit('2026-11-03', [
        ['bea', 2],
        ['cy', 3],
      ]);
      await submit('2026-11-03', [['dan', 2]], sectionB, 1);
      const sessions = await asParent<{ section_id: string }>(
        [studentIds.bea!],
        'select section_id from attendance_sessions',
      );
      expect(sessions.map((s) => s.section_id)).toEqual([sectionA]);
      const marks = await asParent<{ student_enrolment_id: string }>(
        [studentIds.bea!],
        'select student_enrolment_id from attendance_exceptions',
      );
      expect(marks.map((m) => m.student_enrolment_id)).toEqual([enrolments.bea]);
      expect(await asParent([], 'select id from attendance_sessions')).toEqual([]);
      expect(await asParent([], 'select student_enrolment_id from attendance_exceptions')).toEqual(
        [],
      );
    });
  });
});
