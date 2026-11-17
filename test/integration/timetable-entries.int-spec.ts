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

interface Entry {
  id: string;
  sectionId: string;
  sectionName: string | null;
  className: string | null;
  dayOfWeek: number;
  timeSlot: { id: string; periodNo: number; startTime: string; endTime: string };
  isBreak: boolean;
  subject: { id: string; name: string } | null;
  teacher: { id: string; displayName: string } | null;
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

describe('TT-01 to TT-04 the class timetable (API design 9.7, 12.6)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;

  /** Society A: the first Institution has a year, three periods (the third a break), two sections and four teachers. */
  let societyA: string;
  let first: string;
  let second: string;
  let year: string;
  let owner: SignedInPerson;
  let firstAdmin: SignedInPerson;
  let secondAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let sectionA: string;
  let sectionB: string;
  let maths: string;
  let english: string;
  let slotOne: string;
  let slotTwo: string;
  let lunch: string;
  let secondInstitutionSlot: string;
  let anna: SchoolStaff;
  let ben: SchoolStaff;
  let cara: SchoolStaff;
  let dev: SchoolStaff;
  let annaToken: string;
  let benToken: string;
  let parentToken: string;
  let strangerToken: string;
  let childId: string;
  let categoryId: string;
  let strangerChild: string;

  const lesson = (fields: object = {}) => ({
    sectionId: sectionA,
    dayOfWeek: 1,
    timeSlotId: slotOne,
    subjectId: maths,
    staffMemberId: anna.id,
    ...fields,
  });
  const add = (fields: object = {}, token = owner.token) =>
    api('post', '/v1/timetable/entries', token, lesson(fields));
  const added = async (fields: object = {}, token = owner.token) => {
    const res = succeeded(await add(fields, token), 201, 'entry');
    return res.body.data as unknown as Entry;
  };
  const edit = (id: string, fields: object, token = owner.token) =>
    api('patch', `/v1/timetable/entries/${id}`, token, fields);
  const remove = (id: string, token = owner.token) =>
    api('delete', `/v1/timetable/entries/${id}`, token);
  const week = async (query: string, token = owner.token) => {
    const res = await api('get', `/v1/timetable/entries?${query}`, token);
    expect([res.status, query]).toEqual([200, query]);
    return res.body.data as unknown as Entry[];
  };
  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      institution_id: string | null;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);
  const slot = async (institutionId: string, fields: object, token = owner.token) =>
    (
      succeeded(
        await api('post', '/v1/timetable/time-slots', token, { institutionId, ...fields }),
        201,
        'time slot',
      ).body.data as unknown as { id: string }
    ).id;
  const teach = async (staff: SchoolStaff, subjectIds: string[]) =>
    succeeded(
      await api('put', `/v1/staff/${staff.id}/subjects`, owner.token, { subjectIds }),
      200,
      'subjects',
    );

  /** A raw insert into the table, as the app role would, for what the table itself must refuse. */
  const insert = (columns: ReturnType<typeof sql>, values: ReturnType<typeof sql>) =>
    database.transaction(
      { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
      (tx) =>
        sql`insert into timetable_entries (society_id, institution_id, academic_year_id, section_id, day_of_week, time_slot_id, ${columns})
              values (${societyA}, ${first}, ${year}, ${sectionA}, 4, ${slotOne}, ${values})`.execute(
          tx,
        ),
    );
  /** The rows of the timetable a session reads when the request names these children. */
  const seenAsParent = (childIds: string[]) =>
    database.transaction({ personId: owner.person, roleCode: 5, childIds }, async (tx) =>
      (await tx.selectFrom('timetable_entries').select('id').execute()).map((row) => row.id),
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
    societyA = await kit.society(admin);
    owner = await fixtures.owner(societyA);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    year = await kit.year(owner.token, first);
    firstAdmin = await fixtures.institutionAdmin(societyA, [first]);
    secondAdmin = await fixtures.institutionAdmin(societyA, [second]);
    otherOwner = await fixtures.owner(await kit.society(admin));
    slotOne = await slot(first, { periodNo: 1, startTime: '08:30', endTime: '09:10' });
    slotTwo = await slot(first, { periodNo: 2, startTime: '09:10', endTime: '09:50' });
    lunch = await slot(first, {
      periodNo: 3,
      label: 'Lunch',
      startTime: '09:50',
      endTime: '10:10',
      isBreak: true,
    });
    await kit.year(owner.token, second);
    secondInstitutionSlot = await slot(second, {
      periodNo: 1,
      startTime: '08:30',
      endTime: '09:10',
    });
    const classId = await kit.klass(owner.token, first, predefinedClass);
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
    benToken = await kit.actingAs(ben.person.email, TEACHER, societyA);
    succeeded(
      await api('post', '/v1/teaching-assignments', owner.token, {
        staffMemberId: anna.id,
        academicYearId: year,
        sectionId: sectionA,
        subjectId: maths,
      }),
      201,
      'assignment',
    );
    const place = { academicYearId: year, classId, sectionId: sectionA };
    childId = (await kit.student(owner.token, first, place, { guardians: [guardian(parentEmail)] }))
      .id;
    parentToken = (await signInMobile(t, parentEmail)).accessToken;
    const strangerEmail = `${Math.random().toString(36).slice(2)}@parent.test`;
    const strangerInstitution = await kit.institution(otherOwner.token, categoryId);
    const strangerYear = await kit.year(otherOwner.token, strangerInstitution);
    const strangerClass = await kit.klass(otherOwner.token, strangerInstitution, predefinedClass);
    const strangerSection = await kit.section(
      otherOwner.token,
      strangerClass,
      predefinedSections.find((s) => s.code === 'A')!.id,
    );
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

  describe('TT-02 add', () => {
    it('lets the Owner and the Admin add a lesson, shown with the period, subject, teacher and section', async () => {
      const one = await added();
      expect(one).toMatchObject({
        sectionId: sectionA,
        sectionName: 'A',
        dayOfWeek: 1,
        timeSlot: { id: slotOne, periodNo: 1, startTime: '08:30', endTime: '09:10' },
        isBreak: false,
        subject: { id: maths, name: 'Mathematics' },
        teacher: { id: anna.id, displayName: 'Anna Rao' },
        version: 1,
      });
      expect(
        await added({ sectionId: sectionB, staffMemberId: ben.id }, firstAdmin.token),
      ).toMatchObject({ sectionId: sectionB, teacher: { id: ben.id } });
    });

    it('adds a break to a break period, and to any period', async () => {
      const lunchBreak = await added({
        timeSlotId: lunch,
        isBreak: true,
        subjectId: undefined,
        staffMemberId: undefined,
      });
      expect(lunchBreak).toMatchObject({ isBreak: true, subject: null, teacher: null });
      const early = await added({
        dayOfWeek: 2,
        isBreak: true,
        subjectId: undefined,
        staffMemberId: undefined,
      });
      expect(early.isBreak).toBe(true);
    });

    it('writes one audit entry that names the Institution', async () => {
      const made = await added();
      const rows = await audit(made.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'timetable_entry.created',
        institution_id: first,
        new_values: { section_id: sectionA, day_of_week: 1, time_slot_id: slotOne },
      });
    });

    it('refuses a teacher, a parent (403), another Institution’s Admin and another Society (404)', async () => {
      expect((await add({}, annaToken)).status).toBe(403);
      expect((await add({}, parentToken)).status).toBe(403);
      expect((await add({}, secondAdmin.token)).status).toBe(404);
      expect((await add({}, otherOwner.token)).status).toBe(404);
      expect((await add({ sectionId: missing })).status).toBe(404);
      expect(await week(`sectionId=${sectionA}`)).toEqual([]);
    });

    it('refuses what is not an entry: the day, ids, the flag (400)', async () => {
      const cases: [object, Record<string, string>][] = [
        [{ dayOfWeek: 7 }, { dayOfWeek: 'OUT_OF_RANGE' }],
        [{ dayOfWeek: 0 }, { dayOfWeek: 'OUT_OF_RANGE' }],
        [{ dayOfWeek: '1' }, { dayOfWeek: 'INVALID_TYPE' }],
        [{ timeSlotId: 'nope' }, { timeSlotId: 'INVALID_FORMAT' }],
        [{ isBreak: 'yes' }, { isBreak: 'INVALID_TYPE' }],
        [{ institutionId: first }, { institutionId: 'FIELD_NOT_ALLOWED' }],
      ];
      for (const [fields, errors] of cases) {
        const res = await add(fields);
        expect([JSON.stringify(fields), res.status]).toEqual([JSON.stringify(fields), 400]);
        expect(fieldsOf(res)).toEqual(errors);
      }
    });

    it('needs a subject and a teacher for a lesson, and allows a break neither (400)', async () => {
      const none = await add({ subjectId: undefined, staffMemberId: undefined });
      expect(none.status).toBe(400);
      expect(fieldsOf(none)).toEqual({ subjectId: 'REQUIRED', staffMemberId: 'REQUIRED' });
      const half = await add({ staffMemberId: undefined });
      expect(fieldsOf(half)).toEqual({ staffMemberId: 'REQUIRED' });
      const both = await add({ isBreak: true });
      expect(both.status).toBe(400);
      expect(fieldsOf(both)).toEqual({
        subjectId: 'FIELD_NOT_ALLOWED',
        staffMemberId: 'FIELD_NOT_ALLOWED',
      });
    });

    it('is 400 INVALID_SLOT for a period of another Institution, of another year, a deactivated one, or a break period for a lesson', async () => {
      const other = await kit.year(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-04-01',
        endDate: '2028-03-31',
      });
      const nextYear = await slot(first, {
        periodNo: 1,
        startTime: '08:30',
        endTime: '09:10',
        academicYearId: other,
      });
      const gone = await slot(first, { periodNo: 9, startTime: '15:00', endTime: '15:40' });
      await api('delete', `/v1/timetable/time-slots/${gone}`, owner.token);
      for (const timeSlotId of [secondInstitutionSlot, nextYear, gone, lunch, missing]) {
        const res = await add({ timeSlotId });
        expect([timeSlotId, res.status, res.body.code]).toEqual([timeSlotId, 400, 'INVALID_SLOT']);
      }
    });

    it('needs a current year, and an active section', async () => {
      const emptyInstitution = await kit.institution(owner.token, categoryId);
      const res = await add({ sectionId: sectionA });
      expect(res.status).toBe(201);
      expect(emptyInstitution).toBeDefined();
      await api('delete', `/v1/sections/${sectionB}`, owner.token);
      const closed = await add({ sectionId: sectionB });
      expect(closed.status).toBe(422);
      expect(fieldsOf(closed)).toEqual({ sectionId: 'REFERENCE_INACTIVE' });
    });

    it('refuses a subject that is gone (404) or deactivated (422)', async () => {
      expect((await add({ subjectId: missing })).status).toBe(404);
      await api('delete', `/v1/subjects/${english}`, owner.token);
      const res = await add({ subjectId: english });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toEqual({ subjectId: 'REFERENCE_INACTIVE' });
    });

    it('refuses a teacher who cannot teach the subject, is at another Institution, is deactivated or is unknown', async () => {
      const unqualified = await add({ staffMemberId: ben.id, subjectId: english });
      expect([unqualified.status, unqualified.body.code]).toEqual([422, 'SUBJECT_NOT_TAUGHT']);
      const nothing = await add({ staffMemberId: cara.id });
      expect(nothing.body.code).toBe('SUBJECT_NOT_TAUGHT');
      const elsewhere = await add({ staffMemberId: dev.id });
      expect([elsewhere.status, elsewhere.body.code]).toEqual([422, 'STAFF_NOT_AT_INSTITUTION']);
      expect((await add({ staffMemberId: missing })).status).toBe(404);
      await api('delete', `/v1/staff/${ben.id}`, owner.token);
      const gone = await add({ staffMemberId: ben.id });
      expect(gone.status).toBe(422);
      expect(fieldsOf(gone)).toEqual({ staffMemberId: 'REFERENCE_INACTIVE' });
    });

    it('refuses a second entry for a section in its day and period (409 SECTION_SLOT_TAKEN)', async () => {
      await added();
      const res = await add({ staffMemberId: ben.id });
      expect([res.status, res.body.code]).toEqual([409, 'SECTION_SLOT_TAKEN']);
      expect((await add({ dayOfWeek: 2 })).status).toBe(201);
      expect((await add({ timeSlotId: slotTwo })).status).toBe(201);
      expect((await add({ sectionId: sectionB, staffMemberId: ben.id })).status).toBe(201);
    });

    it('refuses a teacher in two places, naming the section and class of the clash (409 TEACHER_DOUBLE_BOOKED)', async () => {
      await added();
      const res = await add({ sectionId: sectionB });
      expect([res.status, res.body.code]).toEqual([409, 'TEACHER_DOUBLE_BOOKED']);
      expect((res.body as unknown as { data: object }).data).toEqual({
        conflict: { sectionName: 'A', className: '10th' },
      });
    });

    it('lets only one of two saves of the same period at once in, for the section and for the teacher', async () => {
      const sectionRace = await Promise.all([
        add({ staffMemberId: anna.id }),
        add({ staffMemberId: ben.id }),
      ]);
      expect(sectionRace.map((r) => r.status).toSorted()).toEqual([201, 409]);
      expect(sectionRace.find((r) => r.status === 409)!.body.code).toBe('SECTION_SLOT_TAKEN');
      const teacherRace = await Promise.all([
        add({ dayOfWeek: 2, sectionId: sectionA }),
        add({ dayOfWeek: 2, sectionId: sectionB }),
      ]);
      expect(teacherRace.map((r) => r.status).toSorted()).toEqual([201, 409]);
      expect(teacherRace.find((r) => r.status === 409)!.body.code).toBe('TEACHER_DOUBLE_BOOKED');
    });
  });

  describe('TT-01 read', () => {
    beforeEach(async () => {
      await added({ dayOfWeek: 2, timeSlotId: slotTwo });
      await added();
      await added({
        timeSlotId: lunch,
        isBreak: true,
        subjectId: undefined,
        staffMemberId: undefined,
      });
      await added({
        sectionId: sectionB,
        dayOfWeek: 1,
        timeSlotId: slotTwo,
        staffMemberId: ben.id,
      });
    });

    it('shows a section’s week by day and period, to the Owner and the Admin', async () => {
      for (const token of [owner.token, firstAdmin.token]) {
        const entries = await week(`sectionId=${sectionA}`, token);
        expect(entries.map((e) => [e.dayOfWeek, e.timeSlot.periodNo, e.isBreak])).toEqual([
          [1, 1, false],
          [1, 3, true],
          [2, 2, false],
        ]);
      }
    });

    it('shows a teacher their own week with `me` and with their ID, and no one else’s', async () => {
      const mine = await week(`staffMemberId=me&institutionId=${first}`, annaToken);
      expect(mine.map((e) => [e.dayOfWeek, e.timeSlot.periodNo, e.sectionName])).toEqual([
        [1, 1, 'A'],
        [2, 2, 'A'],
      ]);
      expect(await week(`staffMemberId=${anna.id}&institutionId=${first}`, annaToken)).toHaveLength(
        2,
      );
      const other = await api(
        'get',
        `/v1/timetable/entries?staffMemberId=${ben.id}&institutionId=${first}`,
        annaToken,
      );
      expect([other.status, other.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      expect(await week(`staffMemberId=${ben.id}&institutionId=${first}`)).toHaveLength(1);
    });

    it('shows a teacher the weeks of the sections they teach, and not the others (403 NOT_ASSIGNED)', async () => {
      expect(await week(`sectionId=${sectionA}`, annaToken)).toHaveLength(3);
      const res = await api('get', `/v1/timetable/entries?sectionId=${sectionB}`, annaToken);
      expect([res.status, res.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      const none = await api('get', `/v1/timetable/entries?sectionId=${sectionA}`, benToken);
      expect(none.status).toBe(403);
    });

    it('shows a parent the week of their child’s section, with subject and teacher names, and no section names', async () => {
      const entries = await week(`studentId=${childId}`, parentToken);
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({
        sectionId: sectionA,
        sectionName: null,
        subject: { name: 'Mathematics' },
        teacher: { displayName: 'Anna Rao' },
      });
    });

    it('is 404 to a parent for another’s child, and asks a parent for the child and nothing else (400)', async () => {
      const res = await api('get', `/v1/timetable/entries?studentId=${strangerChild}`, parentToken);
      expect(res.status).toBe(404);
      expect(
        (await api('get', `/v1/timetable/entries?studentId=${childId}`, strangerToken)).status,
      ).toBe(404);
      const none = await api('get', '/v1/timetable/entries', parentToken);
      expect(fieldsOf(none)).toEqual({ studentId: 'REQUIRED' });
      const named = await api(
        'get',
        `/v1/timetable/entries?studentId=${childId}&sectionId=${sectionA}`,
        parentToken,
      );
      expect(fieldsOf(named)).toEqual({ sectionId: 'FIELD_NOT_ALLOWED' });
    });

    it('asks for one selector, the Institution with a teacher, and refuses a child to anyone but a parent (400)', async () => {
      expect(fieldsOf(await api('get', '/v1/timetable/entries', owner.token))).toEqual({
        sectionId: 'REQUIRED',
      });
      expect(
        fieldsOf(
          await api(
            'get',
            `/v1/timetable/entries?sectionId=${sectionA}&staffMemberId=me`,
            owner.token,
          ),
        ),
      ).toMatchObject({ staffMemberId: 'FIELD_NOT_ALLOWED' });
      expect(
        fieldsOf(await api('get', '/v1/timetable/entries?staffMemberId=me', owner.token)),
      ).toEqual({ institutionId: 'REQUIRED' });
      expect(
        fieldsOf(
          await api(
            'get',
            `/v1/timetable/entries?sectionId=${sectionA}&studentId=${childId}`,
            owner.token,
          ),
        ),
      ).toEqual({ studentId: 'FIELD_NOT_ALLOWED' });
    });

    it('is 404 for a section out of reach, and 422 CURRENT_YEAR_REQUIRED for an Institution without a current year', async () => {
      expect(
        (await api('get', `/v1/timetable/entries?sectionId=${sectionA}`, secondAdmin.token)).status,
      ).toBe(404);
      expect(
        (await api('get', `/v1/timetable/entries?sectionId=${sectionA}`, otherOwner.token)).status,
      ).toBe(404);
      const bare = await kit.institution(owner.token, categoryId);
      const res = await api(
        'get',
        `/v1/timetable/entries?staffMemberId=me&institutionId=${bare}`,
        owner.token,
      );
      expect([res.status, res.body.code]).toEqual([422, 'CURRENT_YEAR_REQUIRED']);
    });

    it('shows a parent only their child’s section, whatever the query says', async () => {
      const all = (await week(`sectionId=${sectionA}`)).map((e) => e.id);
      expect((await seenAsParent([childId])).toSorted()).toEqual(all.toSorted());
      expect(await seenAsParent([])).toEqual([]);
      expect(await seenAsParent([missing])).toEqual([]);
    });
  });

  describe('TT-03 edit', () => {
    it('changes the day, the period, the subject and the teacher, versioned, and audits before and after', async () => {
      const made = await added();
      const res = await edit(made.id, {
        version: 1,
        dayOfWeek: 3,
        timeSlotId: slotTwo,
        subjectId: english,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        dayOfWeek: 3,
        timeSlot: { periodNo: 2 },
        subject: { name: 'English' },
        version: 2,
      });
      const rows = await audit(made.id);
      expect(rows.map((r) => r.action)).toEqual([
        'timetable_entry.created',
        'timetable_entry.updated',
      ]);
      expect(rows[1]).toMatchObject({
        old_values: { day_of_week: 1 },
        new_values: { day_of_week: 3 },
      });
    });

    it('writes nothing for a request that changes nothing', async () => {
      const made = await added();
      const res = await edit(made.id, { version: 1, dayOfWeek: 1, staffMemberId: anna.id });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(1);
      expect(await audit(made.id)).toHaveLength(1);
    });

    it('is 409 VERSION_CONFLICT for an old version, and 400 for a missing one', async () => {
      const made = await added();
      await edit(made.id, { version: 1, dayOfWeek: 2 });
      const old = await edit(made.id, { version: 1, dayOfWeek: 3 });
      expect([old.status, old.body.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await edit(made.id, { dayOfWeek: 3 })).status).toBe(400);
    });

    it('makes a lesson a break, clearing the subject and the teacher, and a break a lesson with both', async () => {
      const made = await added();
      const asBreak = await edit(made.id, { version: 1, isBreak: true });
      expect(asBreak.body.data).toMatchObject({ isBreak: true, subject: null, teacher: null });
      expect(fieldsOf(await edit(made.id, { version: 2, isBreak: false }))).toEqual({
        subjectId: 'REQUIRED',
        staffMemberId: 'REQUIRED',
      });
      const back = await edit(made.id, {
        version: 2,
        isBreak: false,
        subjectId: maths,
        staffMemberId: anna.id,
      });
      expect(back.body.data).toMatchObject({ isBreak: false, subject: { id: maths } });
      expect(
        fieldsOf(await edit(made.id, { version: 3, isBreak: true, subjectId: maths })),
      ).toEqual({ subjectId: 'FIELD_NOT_ALLOWED' });
    });

    it('applies the clash rules to the entry as it would be, and not to itself', async () => {
      const one = await added();
      const two = await added({ dayOfWeek: 2 });
      const taken = await edit(two.id, { version: 1, dayOfWeek: 1 });
      expect([taken.status, taken.body.code]).toEqual([409, 'SECTION_SLOT_TAKEN']);
      await added({
        sectionId: sectionB,
        dayOfWeek: 3,
        timeSlotId: slotTwo,
        staffMemberId: ben.id,
      });
      const booked = await edit(one.id, { version: 1, dayOfWeek: 3, sectionId: undefined });
      expect(booked.status).toBe(200);
      const double = await edit(two.id, {
        version: 1,
        staffMemberId: ben.id,
        dayOfWeek: 3,
        timeSlotId: slotTwo,
      });
      expect([double.status, double.body.code]).toEqual([409, 'TEACHER_DOUBLE_BOOKED']);
      const onBreak = await edit(two.id, { version: 1, timeSlotId: lunch });
      expect([onBreak.status, onBreak.body.code]).toEqual([400, 'INVALID_SLOT']);
      const unqualified = await edit(two.id, {
        version: 1,
        subjectId: english,
        staffMemberId: ben.id,
      });
      expect(unqualified.body.code).toBe('SUBJECT_NOT_TAUGHT');
      expect((await edit(two.id, { version: 1, dayOfWeek: 7 })).status).toBe(400);
    });

    it('is 403 for a teacher, 404 for the wrong Institution and Society, a removed entry or an unknown one', async () => {
      const made = await added();
      expect((await edit(made.id, { version: 1, dayOfWeek: 2 }, annaToken)).status).toBe(403);
      expect((await edit(made.id, { version: 1, dayOfWeek: 2 }, secondAdmin.token)).status).toBe(
        404,
      );
      expect((await edit(made.id, { version: 1, dayOfWeek: 2 }, otherOwner.token)).status).toBe(
        404,
      );
      expect((await edit(missing, { version: 1 })).status).toBe(404);
      await remove(made.id);
      expect((await edit(made.id, { version: 1, dayOfWeek: 2 })).status).toBe(404);
    });
  });

  describe('TT-04 remove and the period it sits in', () => {
    it('removes an entry, audits it, and frees the section’s and the teacher’s place', async () => {
      const made = await added();
      const res = await remove(made.id, firstAdmin.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: made.id, status: 0 });
      expect((await audit(made.id)).map((r) => r.action)).toEqual([
        'timetable_entry.created',
        'timetable_entry.deactivated',
      ]);
      expect(await week(`sectionId=${sectionA}`)).toEqual([]);
      expect(await added()).toMatchObject({ dayOfWeek: 1 });
    });

    it('is 404 the second time, 403 for a teacher, 404 for the wrong Institution and Society', async () => {
      const made = await added();
      expect((await remove(made.id, annaToken)).status).toBe(403);
      expect((await remove(made.id, secondAdmin.token)).status).toBe(404);
      expect((await remove(made.id, otherOwner.token)).status).toBe(404);
      expect((await remove(made.id)).status).toBe(200);
      expect((await remove(made.id)).status).toBe(404);
    });

    it('keeps a period from being deactivated while an entry sits in it (409 TIME_SLOT_IN_USE)', async () => {
      const made = await added();
      const res = await api('delete', `/v1/timetable/time-slots/${slotOne}`, owner.token);
      expect([res.status, res.body.code]).toEqual([409, 'TIME_SLOT_IN_USE']);
      await remove(made.id);
      expect((await api('delete', `/v1/timetable/time-slots/${slotOne}`, owner.token)).status).toBe(
        200,
      );
    });
  });

  describe('the table and the names a parent reads', () => {
    it('keeps a lesson without a teacher, a break with one, and a teacher of another Institution out', async () => {
      await expect(insert(sql`is_break`, sql`false`)).rejects.toMatchObject({ code: '23514' });
      await expect(
        insert(sql`is_break, staff_member_id, subject_id`, sql`true, ${anna.id}, ${maths}`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        insert(sql`is_break, staff_member_id, subject_id`, sql`false, ${dev.id}, ${maths}`),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(insert(sql`is_break`, sql`true`)).resolves.toBeDefined();
    });

    it('does not let the app role delete an entry', async () => {
      const made = await added();
      await expect(
        database.transaction(
          { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
          (tx) => sql`delete from timetable_entries where id = ${made.id}`.execute(tx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('answers a parent the names of their child’s Institution’s teachers, and only that', async () => {
      const names = (childIds: string[], ids: string[]) =>
        database.transaction({ personId: owner.person, roleCode: 5, childIds }, async (tx) =>
          (
            await sql<{
              id: string;
              first_name: string;
              last_name: string | null;
            }>`select * from app_staff_names(${ids}::uuid[])`.execute(tx)
          ).rows
            .map((row) => `${row.first_name} ${row.last_name ?? ''}`.trim())
            .toSorted(),
        );
      expect(await names([childId], [anna.id, dev.id])).toEqual(['Anna Rao']);
      expect(await names([], [anna.id])).toEqual([]);
      const asStaff = await database.transaction(
        { societyId: societyA, institutionIds: [first], roleCode: 3, personId: owner.person },
        async (tx) =>
          (await sql`select * from app_staff_names(${[anna.id]}::uuid[])`.execute(tx)).rows,
      );
      expect(asStaff).toEqual([]);
    });
  });
});
