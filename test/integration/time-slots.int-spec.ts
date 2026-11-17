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

interface Slot {
  id: string;
  institutionId: string;
  academicYearId: string;
  periodNo: number;
  label: string | null;
  startTime: string;
  endTime: string;
  isBreak: boolean;
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

describe('TTS-01 to TTS-04 period timings (API design 9.4)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;

  /** Society A: two Institutions, the first with a current year, a teacher, an Admin and a child. */
  let societyA: string;
  let first: string;
  let second: string;
  let year: string;
  let owner: SignedInPerson;
  let firstAdmin: SignedInPerson;
  let secondAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let teacherToken: string;
  let parentToken: string;
  let strangerToken: string;
  let childId: string;
  let categoryId: string;

  const body = (fields: object = {}) => ({
    institutionId: first,
    periodNo: 1,
    label: 'Period 1',
    startTime: '08:30',
    endTime: '09:10',
    ...fields,
  });
  const add = (fields: object = {}, token = owner.token) =>
    api('post', '/v1/timetable/time-slots', token, body(fields));
  const added = async (fields: object = {}, token = owner.token) => {
    const res = succeeded(await add(fields, token), 201, 'time slot');
    return res.body.data as unknown as Slot;
  };
  const read = (query: string, token = owner.token) =>
    api('get', `/v1/timetable/time-slots?${query}`, token);
  const periods = async (query = `institutionId=${first}`, token = owner.token) => {
    const res = await read(query, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Slot[];
  };
  const edit = (id: string, fields: object, token = owner.token) =>
    api('patch', `/v1/timetable/time-slots/${id}`, token, fields);
  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      institution_id: string | null;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);

  /** The periods a parent's session reads when the request names these children. */
  const seen = (childIds: string[]) =>
    database.transaction(
      { personId: owner.person, roleCode: 5, childIds },
      async (tx) => (await tx.selectFrom('time_slots').select('id').execute()).length,
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

  describe('TTS-02 add', () => {
    it('lets the Owner and the Admin add a period to the current year, shown as HH:MM', async () => {
      const one = await added();
      expect(one).toMatchObject({
        institutionId: first,
        academicYearId: year,
        periodNo: 1,
        label: 'Period 1',
        startTime: '08:30',
        endTime: '09:10',
        isBreak: false,
        status: 1,
        version: 1,
      });
      const lunch = await added(
        { periodNo: 5, label: 'Lunch', startTime: '11:10', endTime: '11:50', isBreak: true },
        firstAdmin.token,
      );
      expect(lunch).toMatchObject({ isBreak: true, label: 'Lunch' });
    });

    it('keeps the label optional', async () => {
      expect(await added({ label: undefined })).toMatchObject({ label: null });
      expect(
        await added({ periodNo: 2, label: null, startTime: '09:10', endTime: '09:50' }),
      ).toMatchObject({
        label: null,
      });
    });

    it('refuses a teacher and a parent (403), an Admin of another Institution and another Society (404)', async () => {
      expect((await add({}, teacherToken)).status).toBe(403);
      expect((await add({}, parentToken)).status).toBe(403);
      expect((await add({}, secondAdmin.token)).status).toBe(404);
      expect((await add({}, otherOwner.token)).status).toBe(404);
      expect((await add({ institutionId: missing })).status).toBe(404);
      expect(await periods()).toEqual([]);
    });

    it('refuses what is not a period: a number, times, a label (400)', async () => {
      const cases: [object, Record<string, string>][] = [
        [{ periodNo: 0 }, { periodNo: 'OUT_OF_RANGE' }],
        [{ periodNo: 31 }, { periodNo: 'OUT_OF_RANGE' }],
        [{ periodNo: '1' }, { periodNo: 'INVALID_TYPE' }],
        [{ startTime: '8:30' }, { startTime: 'INVALID_FORMAT' }],
        [{ endTime: '25:00' }, { endTime: 'INVALID_FORMAT' }],
        [{ endTime: '08:30' }, { endTime: 'OUT_OF_RANGE' }],
        [{ endTime: '08:00' }, { endTime: 'OUT_OF_RANGE' }],
        [{ label: '   ' }, { label: 'TOO_SHORT' }],
        [{ academicYearId: 'nope' }, { academicYearId: 'INVALID_FORMAT' }],
        [{ societyId: missing }, { societyId: 'FIELD_NOT_ALLOWED' }],
      ];
      for (const [fields, errors] of cases) {
        const res = await add(fields);
        expect([JSON.stringify(fields), res.status]).toEqual([JSON.stringify(fields), 400]);
        expect(fieldsOf(res)).toEqual(errors);
      }
      expect(await periods()).toEqual([]);
    });

    it('refuses a number in use (409 DUPLICATE), and an overlap (409 TIME_SLOT_OVERLAP) however it overlaps', async () => {
      await added();
      const again = await add({ startTime: '10:00', endTime: '10:40' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('DUPLICATE');
      expect(fieldsOf(again)).toEqual({ periodNo: 'DUPLICATE' });
      for (const [start, end] of [
        ['08:30', '09:10'],
        ['08:00', '08:31'],
        ['09:09', '09:30'],
        ['08:40', '09:00'],
        ['08:00', '10:00'],
        ['08:30', '09:00'],
      ]) {
        const res = await add({ periodNo: 2, startTime: start, endTime: end });
        expect([`${start} to ${end}`, res.status]).toEqual([`${start} to ${end}`, 409]);
        expect(res.body.code).toBe('TIME_SLOT_OVERLAP');
        expect(fieldsOf(res)).toEqual({ startTime: 'TIME_SLOT_OVERLAP' });
      }
      expect(await periods()).toHaveLength(1);
    });

    it('lets one period end when the next begins, and numbers need not follow the clock', async () => {
      await added({ periodNo: 2, startTime: '09:10', endTime: '09:50' });
      await added({ periodNo: 1, startTime: '08:30', endTime: '09:10' });
      await added({ periodNo: 3, startTime: '09:50', endTime: '10:30' });
      expect((await periods()).map((p) => [p.periodNo, p.startTime])).toEqual([
        [1, '08:30'],
        [2, '09:10'],
        [3, '09:50'],
      ]);
    });

    it('lets only one of two overlapping periods saved at once in', async () => {
      const answers = await Promise.all([
        add({ periodNo: 1, startTime: '08:30', endTime: '09:10' }),
        add({ periodNo: 2, startTime: '09:00', endTime: '09:40' }),
      ]);
      expect(answers.map((a) => a.status).toSorted()).toEqual([201, 409]);
      expect(await periods()).toHaveLength(1);
    });

    it('keeps the periods of each Institution and year apart', async () => {
      await kit.year(owner.token, second);
      await added();
      await added({ institutionId: second });
      const next = await kit.year(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-04-01',
        endDate: '2028-03-31',
      });
      const nextOne = await added({ academicYearId: next });
      expect(nextOne.academicYearId).toBe(next);
      expect(await periods()).toHaveLength(1);
      expect(await periods(`institutionId=${first}&academicYearId=${next}`)).toHaveLength(1);
      expect(await periods(`institutionId=${second}`, secondAdmin.token)).toHaveLength(1);
    });

    it('is 422 CURRENT_YEAR_REQUIRED for an Institution with no current year, and for a year that is deactivated 422 REFERENCE_INACTIVE', async () => {
      const bare = await add({ institutionId: second });
      expect(bare.status).toBe(422);
      expect(bare.body.code).toBe('CURRENT_YEAR_REQUIRED');
      const old = await kit.year(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-04-01',
        endDate: '2028-03-31',
      });
      expect((await api('delete', `/v1/academic-years/${old}`, owner.token)).status).toBe(200);
      const closed = await add({ academicYearId: old });
      expect(closed.status).toBe(422);
      expect(fieldsOf(closed)).toEqual({ academicYearId: 'REFERENCE_INACTIVE' });
    });

    it('is 404 for a year of another Institution', async () => {
      const elsewhere = await kit.year(owner.token, second);
      expect((await add({ academicYearId: elsewhere })).status).toBe(404);
    });

    it('writes one audit entry that names the Institution', async () => {
      const made = await added();
      const rows = await audit(made.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'time_slot.created',
        institution_id: first,
        new_values: { period_no: 1, start_time: '08:30', end_time: '09:10', is_break: false },
      });
    });
  });

  describe('TTS-01 read', () => {
    it('shows the current year’s periods, earliest first, to the Owner, the Admin and a teacher of the Institution', async () => {
      await added({ periodNo: 2, startTime: '09:10', endTime: '09:50' });
      await added();
      for (const token of [owner.token, firstAdmin.token, teacherToken]) {
        expect((await periods(`institutionId=${first}`, token)).map((p) => p.periodNo)).toEqual([
          1, 2,
        ]);
      }
    });

    it('shows nothing of a deactivated period', async () => {
      const gone = await added();
      await added({ periodNo: 2, startTime: '09:10', endTime: '09:50' });
      expect((await api('delete', `/v1/timetable/time-slots/${gone.id}`, owner.token)).status).toBe(
        200,
      );
      expect((await periods()).map((p) => p.periodNo)).toEqual([2]);
    });

    it('is 404 for an Institution the caller does not reach and for a year of another', async () => {
      expect((await read(`institutionId=${first}`, secondAdmin.token)).status).toBe(404);
      expect((await read(`institutionId=${first}`, otherOwner.token)).status).toBe(404);
      const elsewhere = await kit.year(owner.token, second);
      expect((await read(`institutionId=${first}&academicYearId=${elsewhere}`)).status).toBe(404);
      expect((await read(`institutionId=${first}&academicYearId=${missing}`)).status).toBe(404);
    });

    it('is 400 without an Institution, and 400 for a child named by someone who is not a parent', async () => {
      const without = await read('');
      expect(without.status).toBe(400);
      expect(fieldsOf(without)).toEqual({ institutionId: 'REQUIRED' });
      const child = await read(`institutionId=${first}&studentId=${childId}`);
      expect(child.status).toBe(400);
      expect(fieldsOf(child)).toEqual({ studentId: 'FIELD_NOT_ALLOWED' });
    });

    it('is 422 CURRENT_YEAR_REQUIRED for an Institution with no current year', async () => {
      const res = await read(`institutionId=${second}`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CURRENT_YEAR_REQUIRED');
    });

    it('lets a parent read their child’s Institution, and nothing else', async () => {
      await added();
      await added({ institutionId: second, academicYearId: await kit.year(owner.token, second) });
      const slots = await periods(`studentId=${childId}`, parentToken);
      expect(slots).toHaveLength(1);
      expect(slots[0]).toMatchObject({ institutionId: first, startTime: '08:30' });
      expect((await read(`studentId=${childId}`, strangerToken)).status).toBe(404);
      const none = await read('', parentToken);
      expect(none.status).toBe(400);
      expect(fieldsOf(none)).toEqual({ studentId: 'REQUIRED' });
      const named = await read(`studentId=${childId}&institutionId=${first}`, parentToken);
      expect(named.status).toBe(400);
      expect(fieldsOf(named)).toEqual({ institutionId: 'FIELD_NOT_ALLOWED' });
      const named2 = await read(`studentId=${childId}&academicYearId=${missing}`, parentToken);
      expect(fieldsOf(named2)).toEqual({ academicYearId: 'FIELD_NOT_ALLOWED' });
    });

    it('shows a parent no period without a child in the request, whatever the query says', async () => {
      await added();
      expect(await seen([])).toBe(0);
      expect(await seen([missing])).toBe(0);
      expect(await seen([childId])).toBe(1);
    });
  });

  describe('TTS-03 edit', () => {
    it('changes the label and the times, versioned, and audits before and after', async () => {
      const made = await added();
      const res = await edit(made.id, { version: 1, label: 'First', startTime: '08:35' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        label: 'First',
        startTime: '08:35',
        endTime: '09:10',
        version: 2,
      });
      const rows = await audit(made.id);
      expect(rows.map((r) => r.action)).toEqual(['time_slot.created', 'time_slot.updated']);
      expect(rows[1]).toMatchObject({
        old_values: { start_time: '08:30', label: 'Period 1' },
        new_values: { start_time: '08:35', label: 'First' },
      });
    });

    it('clears the label with null, and writes nothing for a request that changes nothing', async () => {
      const made = await added();
      expect((await edit(made.id, { version: 1, label: null })).body.data).toMatchObject({
        label: null,
        version: 2,
      });
      const same = await edit(made.id, { version: 2, label: null, startTime: '08:30' });
      expect(same.status).toBe(200);
      expect(same.body.data.version).toBe(2);
      expect(await audit(made.id)).toHaveLength(2);
    });

    it('is 409 VERSION_CONFLICT for an old version, and 400 for a missing one', async () => {
      const made = await added();
      await edit(made.id, { version: 1, label: 'x' });
      const old = await edit(made.id, { version: 1, label: 'y' });
      expect(old.status).toBe(409);
      expect(old.body.code).toBe('VERSION_CONFLICT');
      expect((await edit(made.id, { label: 'y' })).status).toBe(400);
    });

    it('refuses an end that is not after the start, with the time that stays counted', async () => {
      const made = await added();
      const end = await edit(made.id, { version: 1, endTime: '08:30' });
      expect(end.status).toBe(400);
      expect(fieldsOf(end)).toEqual({ endTime: 'OUT_OF_RANGE' });
      const start = await edit(made.id, { version: 1, startTime: '09:10' });
      expect(start.status).toBe(400);
      expect(fieldsOf(start)).toEqual({ endTime: 'OUT_OF_RANGE' });
    });

    it('refuses an overlap with another period (409), but not with itself', async () => {
      const one = await added();
      await added({ periodNo: 2, startTime: '09:10', endTime: '09:50' });
      const over = await edit(one.id, { version: 1, endTime: '09:20' });
      expect(over.status).toBe(409);
      expect(over.body.code).toBe('TIME_SLOT_OVERLAP');
      expect((await edit(one.id, { version: 1, endTime: '09:05' })).status).toBe(200);
    });

    it('does not take the number or the break flag, and is 403 for a teacher and 404 for the wrong Institution or a deactivated period', async () => {
      const made = await added();
      expect((await edit(made.id, { version: 1, periodNo: 2 })).status).toBe(400);
      expect((await edit(made.id, { version: 1, isBreak: true })).status).toBe(400);
      expect((await edit(made.id, { version: 1, label: 'x' }, teacherToken)).status).toBe(403);
      expect((await edit(made.id, { version: 1, label: 'x' }, secondAdmin.token)).status).toBe(404);
      expect((await edit(made.id, { version: 1, label: 'x' }, otherOwner.token)).status).toBe(404);
      expect((await edit(missing, { version: 1, label: 'x' })).status).toBe(404);
      await api('delete', `/v1/timetable/time-slots/${made.id}`, owner.token);
      expect((await edit(made.id, { version: 1, label: 'x' })).status).toBe(404);
    });
  });

  describe('TTS-04 deactivate', () => {
    it('deactivates, audits, and frees the number and the times', async () => {
      const made = await added();
      const res = await api('delete', `/v1/timetable/time-slots/${made.id}`, firstAdmin.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: made.id, status: 0 });
      expect((await audit(made.id)).map((r) => r.action)).toEqual([
        'time_slot.created',
        'time_slot.deactivated',
      ]);
      expect(await added()).toMatchObject({ periodNo: 1, startTime: '08:30' });
    });

    it('is 404 the second time, for the wrong Institution and Society, and 403 for a teacher', async () => {
      const made = await added();
      const del = (token: string) => api('delete', `/v1/timetable/time-slots/${made.id}`, token);
      expect((await del(teacherToken)).status).toBe(403);
      expect((await del(secondAdmin.token)).status).toBe(404);
      expect((await del(otherOwner.token)).status).toBe(404);
      expect((await del(owner.token)).status).toBe(200);
      expect((await del(owner.token)).status).toBe(404);
    });
  });

  describe('the table', () => {
    it('refuses to be deleted from by the app role, and a period outside the clock', async () => {
      const made = await added();
      await expect(
        database.transaction(
          { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
          (tx) => sql`delete from time_slots where id = ${made.id}`.execute(tx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        database.transaction(
          { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
          (tx) =>
            sql`insert into time_slots (society_id, institution_id, academic_year_id, period_no, start_time, end_time)
              values (${societyA}, ${first}, ${year}, 9, '10:00', '10:00')`.execute(tx),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('does not let a period name a year of another Institution', async () => {
      const elsewhere = await kit.year(owner.token, second);
      await expect(
        database.transaction(
          { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
          (tx) =>
            sql`insert into time_slots (society_id, institution_id, academic_year_id, period_no, start_time, end_time)
              values (${societyA}, ${first}, ${elsewhere}, 9, '10:00', '10:40')`.execute(tx),
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });
});
