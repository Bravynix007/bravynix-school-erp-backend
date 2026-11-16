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
import { SchoolKit } from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

interface Event {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  audience: number;
  scope: number;
  institutionId: string | null;
  isHoliday: boolean;
  holidayType: number | null;
  holidayForStudents: boolean;
  holidayForStaff: boolean;
  holidayPredefinedClassIds: string[];
  canEdit: boolean;
  status: number;
  version: number;
}

const holiday = (fields: object = {}) => ({
  title: 'Sports Day',
  isHoliday: true,
  holidayType: 3,
  holidayForStudents: true,
  ...fields,
});

const fieldsOf = (res: { body: { errors?: { field: string; code: string }[] } }) =>
  Object.fromEntries((res.body.errors ?? []).map((e) => [e.field, e.code]));

describe('EVT-01 to EVT-06 events and holidays (PRD 7.12, API design 10.26)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;

  /** Society A has two Institutions; its Admin has the first only. Society B is another world. */
  let societyA: string;
  let first: string;
  let second: string;
  let owner: SignedInPerson;
  let firstAdmin: SignedInPerson;
  let secondAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let teacherToken: string;
  let classIds: string[];

  const body = (fields: object = {}) => ({
    title: 'Annual Day',
    startDate: '2026-12-22',
    endDate: '2026-12-24',
    durationLabel: '3 Days',
    scope: 2,
    institutionId: first,
    ...fields,
  });

  const add = (token: string, fields: object = {}) =>
    api('post', '/v1/events', token, body(fields));

  const added = async (fields: object = {}, token = owner.token) => {
    const res = await add(token, fields);
    expect(res.status).toBe(201);
    return res.body.data as unknown as Event;
  };

  const list = async (query: string, token = owner.token) => {
    const res = await api('get', `/v1/events?${query}`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Event[];
  };

  const titles = async (query: string, token = owner.token) =>
    (await list(query, token)).map((e) => e.title);

  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      institution_id: string | null;
      society_id: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);

  const edit = (id: string, fields: object, token = owner.token) =>
    api('patch', `/v1/events/${id}`, token, fields);

  const move = (id: string, fields: object, token = owner.token) =>
    api('post', `/v1/events/${id}/scope`, token, fields);

  const insertEvent = (institutionId: string | null, roleCode: number, institutionIds: string[]) =>
    database.transaction({ societyId: societyA, institutionIds, roleCode }, (tx) =>
      sql`insert into events (society_id, scope, institution_id, title, start_date, end_date, duration_label)
        values (${societyA}, ${institutionId === null ? 1 : 2}, ${institutionId}, 'x', '2026-12-01', '2026-12-01', '1 Day')`.execute(
        tx,
      ),
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
    const categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    classIds = (await kit.masters(admin, 'predefined-classes')).slice(0, 3).map((c) => c.id);
    societyA = await kit.society(admin);
    owner = await fixtures.owner(societyA);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    firstAdmin = await fixtures.institutionAdmin(societyA, [first]);
    secondAdmin = await fixtures.institutionAdmin(societyA, [second]);
    const societyB = await kit.society(admin);
    otherOwner = await fixtures.owner(societyB);
    const teacher = await kit.staff(owner.token, first, categoryId);
    teacherToken = await kit.actingAs(teacher.person.email, 4, societyA);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('EVT-02 create', () => {
    it('lets the Owner make a Society event and an Institution event, and the Admin only theirs', async () => {
      const society = await added({ scope: 1, institutionId: undefined, title: 'Founders Day' });
      expect(society).toMatchObject({
        scope: 1,
        institutionId: null,
        audience: 1,
        isHoliday: false,
        canEdit: true,
        status: 1,
        version: 1,
      });
      const mine = await added({ title: 'Mine' }, firstAdmin.token);
      expect(mine).toMatchObject({ scope: 2, institutionId: first, canEdit: true });
      expect(await added({ institutionId: second, title: 'Second' })).toMatchObject({
        institutionId: second,
      });
    });

    it('refuses an Admin a Society event (403 SCOPE_NOT_ALLOWED), an Institution that is not theirs (404), and a teacher (403)', async () => {
      const society = await add(firstAdmin.token, { scope: 1, institutionId: undefined });
      expect(society.status).toBe(403);
      expect(society.body.code).toBe('SCOPE_NOT_ALLOWED');
      expect((await add(firstAdmin.token, { institutionId: second })).status).toBe(404);
      expect((await add(owner.token, { institutionId: missing })).status).toBe(404);
      expect((await add(otherOwner.token, { institutionId: first })).status).toBe(404);
      expect((await add(teacherToken)).status).toBe(403);
      expect(await list('from=2026-01-01&to=2026-12-31')).toEqual([]);
    });

    it('needs an Institution exactly when the scope is 2', async () => {
      const without = await add(owner.token, { institutionId: undefined });
      expect(without.status).toBe(400);
      expect(fieldsOf(without)).toEqual({ institutionId: 'REQUIRED' });
      const withOne = await add(owner.token, { scope: 1 });
      expect(withOne.status).toBe(400);
      expect(fieldsOf(withOne)).toEqual({ institutionId: 'FIELD_NOT_ALLOWED' });
    });

    it('checks the fields that go together, naming each one that is wrong', async () => {
      const backwards = await add(owner.token, { endDate: '2026-12-21' });
      expect(fieldsOf(backwards)).toEqual({ endDate: 'INVALID_VALUE' });
      const bare = await add(owner.token, { isHoliday: true });
      expect(fieldsOf(bare)).toEqual({ holidayType: 'REQUIRED', holidayForStudents: 'REQUIRED' });
      const notHoliday = await add(owner.token, {
        holidayType: 1,
        holidayForStaff: true,
        holidayPredefinedClassIds: [classIds[0]],
      });
      expect(fieldsOf(notHoliday)).toEqual({
        holidayType: 'FIELD_NOT_ALLOWED',
        holidayForStaff: 'FIELD_NOT_ALLOWED',
        holidayPredefinedClassIds: 'FIELD_NOT_ALLOWED',
      });
      const forStaff = await add(
        owner.token,
        holiday({
          holidayForStudents: false,
          holidayForStaff: true,
          holidayPredefinedClassIds: [classIds[0]],
        }),
      );
      expect(fieldsOf(forStaff)).toEqual({ holidayPredefinedClassIds: 'FIELD_NOT_ALLOWED' });
      const twice = await add(
        owner.token,
        holiday({ holidayPredefinedClassIds: [classIds[0], classIds[0]] }),
      );
      expect(fieldsOf(twice)).toEqual({ holidayPredefinedClassIds: 'INVALID_VALUE' });
      const picture = await add(owner.token, { presetImageCode: 'unicorn' });
      expect(fieldsOf(picture)).toEqual({ presetImageCode: 'INVALID_CODE' });
      const audience = await add(owner.token, { audience: 4 });
      expect(audience.status).toBe(400);
    });

    it('keeps the classes of a holiday, and 404s one that does not exist', async () => {
      const made = await added(holiday({ holidayPredefinedClassIds: [classIds[1], classIds[0]] }));
      expect(made.holidayPredefinedClassIds).toEqual([classIds[0], classIds[1]].toSorted());
      const unknown = await add(owner.token, holiday({ holidayPredefinedClassIds: [missing] }));
      expect(unknown.status).toBe(404);
    });

    it('writes one audit entry that names the Institution of an Institution event, and none for a Society event', async () => {
      const mine = await added({ title: 'Mine' });
      const society = await added({ scope: 1, institutionId: undefined, title: 'All' });
      const [mineRow] = await audit(mine.id);
      expect(mineRow).toMatchObject({
        action: 'event.created',
        institution_id: first,
        society_id: societyA,
        old_values: null,
        new_values: expect.objectContaining({ title: 'Mine', scope: 2, institutionId: first }),
      });
      const [societyRow] = await audit(society.id);
      expect(societyRow).toMatchObject({ action: 'event.created', institution_id: null });
    });
  });

  describe('EVT-01 list', () => {
    it('lists the events with a day in the span, earliest first, including one that began before it', async () => {
      await added({ title: 'Later', startDate: '2026-12-10', endDate: '2026-12-10' });
      await added({ title: 'Earlier', startDate: '2026-12-01', endDate: '2026-12-02' });
      await added({ title: 'Straddles', startDate: '2026-11-28', endDate: '2026-12-01' });
      await added({ title: 'Outside', startDate: '2026-11-01', endDate: '2026-11-27' });
      await added({ title: 'After', startDate: '2026-12-31', endDate: '2026-12-31' });
      expect(await titles('from=2026-12-01&to=2026-12-30')).toEqual([
        'Straddles',
        'Earlier',
        'Later',
      ]);
    });

    it('gives the Society’s events with each Institution’s, and an Admin only their own Institutions’', async () => {
      await added({ scope: 1, institutionId: undefined, title: 'Society' });
      await added({ title: 'First' });
      await added({ title: 'Second', institutionId: second });
      const span = 'from=2026-12-01&to=2026-12-31';
      expect((await titles(span)).toSorted()).toEqual(['First', 'Second', 'Society']);
      expect((await titles(span, firstAdmin.token)).toSorted()).toEqual(['First', 'Society']);
      expect((await titles(span, secondAdmin.token)).toSorted()).toEqual(['Second', 'Society']);
      expect((await titles(`${span}&institutionId=${second}`)).toSorted()).toEqual([
        'Second',
        'Society',
      ]);
      expect(
        (await api('get', `/v1/events?${span}&institutionId=${second}`, firstAdmin.token)).status,
      ).toBe(404);
      expect(await titles(span, otherOwner.token)).toEqual([]);
    });

    it('shows each role the audiences it is told about, and says what it may edit', async () => {
      await added({ title: 'Everyone', audience: 1 });
      await added({ title: 'Families', audience: 2 });
      await added({ title: 'Staff', audience: 3 });
      await added({ scope: 1, institutionId: undefined, title: 'Society' });
      const span = 'from=2026-12-01&to=2026-12-31';
      expect((await titles(span, owner.token)).toSorted()).toEqual([
        'Everyone',
        'Families',
        'Society',
        'Staff',
      ]);
      expect((await titles(span, teacherToken)).toSorted()).toEqual([
        'Everyone',
        'Society',
        'Staff',
      ]);
      const asAdmin = await list(span, firstAdmin.token);
      expect(Object.fromEntries(asAdmin.map((e) => [e.title, e.canEdit]))).toEqual({
        Everyone: true,
        Families: true,
        Staff: true,
        Society: false,
      });
      const asTeacher = await list(span, teacherToken);
      expect(asTeacher.every((e) => !e.canEdit)).toBe(true);
    });

    it('keeps holidays only when asked, and leaves out what is deactivated', async () => {
      await added(holiday({ title: 'Holiday' }));
      const gone = await added({ title: 'Gone' });
      await added({ title: 'Plain' });
      expect((await api('delete', `/v1/events/${gone.id}`, owner.token)).status).toBe(200);
      const span = 'from=2026-12-01&to=2026-12-31';
      expect((await titles(span)).toSorted()).toEqual(['Holiday', 'Plain']);
      expect(await titles(`${span}&holidays=true`)).toEqual(['Holiday']);
    });

    it('takes an academic year of an Institution in place of dates', async () => {
      const yearId = await kit.year(owner.token, first);
      await added({ title: 'In the year', startDate: '2026-09-01', endDate: '2026-09-01' });
      await added({ title: 'Before', startDate: '2026-05-31', endDate: '2026-05-31' });
      await added({ title: 'After', startDate: '2027-04-01', endDate: '2027-04-01' });
      expect(await titles(`academicYearId=${yearId}&institutionId=${first}`)).toEqual([
        'In the year',
      ]);
      const noInstitution = await api('get', `/v1/events?academicYearId=${yearId}`, owner.token);
      expect(fieldsOf(noInstitution)).toEqual({ institutionId: 'REQUIRED' });
      const both = await api(
        'get',
        `/v1/events?academicYearId=${yearId}&institutionId=${first}&from=2026-01-01`,
        owner.token,
      );
      expect(fieldsOf(both)).toEqual({ from: 'FIELD_NOT_ALLOWED' });
      const elsewhere = await api(
        'get',
        `/v1/events?academicYearId=${yearId}&institutionId=${second}`,
        owner.token,
      );
      expect(elsewhere.status).toBe(404);
    });

    it('asks for both dates, in order, and at most 366 days', async () => {
      expect(fieldsOf(await api('get', '/v1/events', owner.token))).toEqual({
        from: 'REQUIRED',
        to: 'REQUIRED',
      });
      expect(fieldsOf(await api('get', '/v1/events?from=2026-12-01', owner.token))).toEqual({
        to: 'REQUIRED',
      });
      expect(
        fieldsOf(await api('get', '/v1/events?from=2026-12-02&to=2026-12-01', owner.token)),
      ).toEqual({ to: 'INVALID_VALUE' });
      const yearAndADay = await api('get', '/v1/events?from=2026-01-01&to=2027-01-02', owner.token);
      expect(yearAndADay.status).toBe(400);
      expect(yearAndADay.body.code).toBe('RANGE_TOO_LARGE');
      expect(
        (await api('get', '/v1/events?from=2026-01-01&to=2027-01-01', owner.token)).status,
      ).toBe(200);
    });
  });

  describe('EVT-03 one event', () => {
    it('is read by those the event is for, and is 404 for anyone else, with the same answer for a missing one', async () => {
      const staff = await added({ title: 'Staff only', audience: 3 });
      const families = await added({ title: 'Families', audience: 2 });
      const read = (id: string, token: string) => api('get', `/v1/events/${id}`, token);
      expect((await read(staff.id, teacherToken)).body.data).toMatchObject({
        id: staff.id,
        canEdit: false,
      });
      expect((await read(families.id, teacherToken)).status).toBe(404);
      expect((await read(families.id, firstAdmin.token)).status).toBe(200);
      expect((await read(staff.id, secondAdmin.token)).status).toBe(404);
      expect((await read(staff.id, otherOwner.token)).status).toBe(404);
      expect((await read(missing, owner.token)).status).toBe(404);
      await api('delete', `/v1/events/${staff.id}`, owner.token);
      expect((await read(staff.id, owner.token)).status).toBe(404);
    });
  });

  describe('EVT-04 edit', () => {
    it('changes the fields sent, leaves the rest, and bumps the version', async () => {
      const made = await added({ venue: 'Hall', description: 'Fun' });
      const res = await edit(made.id, { version: 1, title: 'Annual Day 2026', venue: null });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        title: 'Annual Day 2026',
        venue: null,
        description: 'Fun',
        startDate: '2026-12-22',
        version: 2,
      });
    });

    it('answers a stale version with 409 and a missing version with 400', async () => {
      const made = await added();
      await edit(made.id, { version: 1, title: 'One' });
      const stale = await edit(made.id, { version: 1, title: 'Two' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect((await edit(made.id, { title: 'Two' })).status).toBe(400);
    });

    it('lets an Admin change an event of their Institution and refuses the Society’s (403) and another Institution’s (404)', async () => {
      const mine = await added({ title: 'Mine' });
      const society = await added({ scope: 1, institutionId: undefined, title: 'All' });
      const theirs = await added({ title: 'Theirs', institutionId: second });
      expect((await edit(mine.id, { version: 1, title: 'Mine 2' }, firstAdmin.token)).status).toBe(
        200,
      );
      const refused = await edit(society.id, { version: 1, title: 'x' }, firstAdmin.token);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('SCOPE_NOT_ALLOWED');
      expect((await edit(theirs.id, { version: 1, title: 'x' }, firstAdmin.token)).status).toBe(
        404,
      );
      expect((await edit(mine.id, { version: 2, title: 'x' }, teacherToken)).status).toBe(403);
      expect((await edit(society.id, { version: 1, title: 'All 2' })).status).toBe(200);
    });

    it('checks the whole event as it will be, not only the fields sent', async () => {
      const made = await added({ startDate: '2026-12-22', endDate: '2026-12-24' });
      const early = await edit(made.id, { version: 1, endDate: '2026-12-21' });
      expect(fieldsOf(early)).toEqual({ endDate: 'INVALID_VALUE' });
      const holidayNoType = await edit(made.id, { version: 1, isHoliday: true });
      expect(fieldsOf(holidayNoType)).toEqual({
        holidayType: 'REQUIRED',
        holidayForStudents: 'REQUIRED',
      });
      const stillThere = await list('from=2026-12-01&to=2026-12-31');
      expect(stillThere[0]).toMatchObject({ endDate: '2026-12-24', version: 1 });
    });

    it('turns an event into a holiday and back, clearing the holiday fields and classes', async () => {
      const made = await added();
      const holidayRes = await edit(made.id, {
        version: 1,
        isHoliday: true,
        holidayType: 2,
        holidayForStudents: true,
        holidayPredefinedClassIds: [classIds[0]],
      });
      expect(holidayRes.body.data).toMatchObject({
        isHoliday: true,
        holidayType: 2,
        holidayForStudents: true,
        holidayPredefinedClassIds: [classIds[0]],
      });
      const classesOnly = await edit(made.id, { version: 2, holidayPredefinedClassIds: [] });
      expect(classesOnly.body.data.holidayPredefinedClassIds).toEqual([]);
      const back = await edit(made.id, { version: 3, isHoliday: false });
      expect(back.body.data).toMatchObject({
        isHoliday: false,
        holidayType: null,
        holidayForStudents: false,
        holidayForStaff: false,
        holidayPredefinedClassIds: [],
      });
    });

    it('writes nothing for a request that changes nothing, and one audit entry with before and after for one that does', async () => {
      const made = await added({ title: 'Same' });
      const same = await edit(made.id, { version: 1, title: 'Same', venue: null });
      expect(same.body.data).toMatchObject({ version: 1 });
      expect(await audit(made.id)).toHaveLength(1);
      await edit(made.id, { version: 1, title: 'Changed' });
      const rows = await audit(made.id);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        action: 'event.updated',
        institution_id: first,
        old_values: expect.objectContaining({ title: 'Same' }),
        new_values: expect.objectContaining({ title: 'Changed' }),
      });
    });
  });

  describe('EVT-05 deactivate', () => {
    it('deactivates for who may edit, once, and keeps the row', async () => {
      const mine = await added({ title: 'Mine' });
      const society = await added({ scope: 1, institutionId: undefined, title: 'All' });
      const refused = await api('delete', `/v1/events/${society.id}`, firstAdmin.token);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('SCOPE_NOT_ALLOWED');
      expect((await api('delete', `/v1/events/${mine.id}`, secondAdmin.token)).status).toBe(404);
      expect((await api('delete', `/v1/events/${mine.id}`, teacherToken)).status).toBe(403);
      const done = await api('delete', `/v1/events/${mine.id}`, firstAdmin.token);
      expect(done.body.data).toEqual({ id: mine.id, status: 0 });
      expect((await api('delete', `/v1/events/${mine.id}`, firstAdmin.token)).status).toBe(404);
      const stored = await database.transaction(
        { societyId: societyA, institutionIds: [first] },
        (tx) =>
          sql<{ status: number }>`select status from events where id = ${mine.id}`.execute(tx),
      );
      expect(stored.rows[0]?.status).toBe(0);
      expect((await audit(mine.id)).map((r) => r.action)).toEqual([
        'event.created',
        'event.deactivated',
      ]);
      expect((await api('delete', `/v1/events/${society.id}`, owner.token)).status).toBe(200);
    });
  });

  describe('EVT-06 scope', () => {
    it('moves an event between the Society and an Institution, which changes who may edit it', async () => {
      const made = await added({ title: 'Mine' });
      const up = await move(made.id, { version: 1, scope: 1 });
      expect(up.status).toBe(200);
      expect(up.body.data).toMatchObject({ scope: 1, institutionId: null, version: 2 });
      expect(
        (await api('patch', `/v1/events/${made.id}`, firstAdmin.token, { version: 2, title: 'x' }))
          .status,
      ).toBe(403);
      const down = await move(made.id, { version: 2, scope: 2, institutionId: second });
      expect(down.body.data).toMatchObject({ scope: 2, institutionId: second, version: 3 });
      expect(await titles('from=2026-12-01&to=2026-12-31', firstAdmin.token)).not.toContain('Mine');
      expect((await audit(made.id)).map((r) => r.action)).toEqual([
        'event.created',
        'event.scope_changed',
        'event.scope_changed',
      ]);
    });

    it('is for the Owner only, and needs the Institution exactly when the scope is 2', async () => {
      const made = await added();
      expect((await move(made.id, { version: 1, scope: 1 }, firstAdmin.token)).status).toBe(403);
      expect((await move(made.id, { version: 1, scope: 1 }, teacherToken)).status).toBe(403);
      expect(fieldsOf(await move(made.id, { version: 1, scope: 2 }))).toEqual({
        institutionId: 'REQUIRED',
      });
      expect(
        fieldsOf(await move(made.id, { version: 1, scope: 1, institutionId: second })),
      ).toEqual({
        institutionId: 'FIELD_NOT_ALLOWED',
      });
      expect((await move(made.id, { version: 1, scope: 2, institutionId: missing })).status).toBe(
        404,
      );
      expect((await move(made.id, { version: 1, scope: 1 }, otherOwner.token)).status).toBe(404);
      expect((await move(made.id, { version: 9, scope: 1 })).body.code).toBe('VERSION_CONFLICT');
    });

    it('writes nothing when the event is already there', async () => {
      const made = await added();
      const same = await move(made.id, { version: 1, scope: 2, institutionId: first });
      expect(same.body.data).toMatchObject({ version: 1 });
      expect(await audit(made.id)).toHaveLength(1);
    });
  });

  describe('row-level security, as the app role', () => {
    it('refuses a Society event to an Admin and an event of an Institution out of reach, whatever the service does', async () => {
      await expect(insertEvent(null, 3, [first])).rejects.toMatchObject({ code: '42501' });
      await expect(insertEvent(second, 3, [first])).rejects.toMatchObject({ code: '42501' });
      await expect(insertEvent(first, 3, [first])).resolves.toBeDefined();
      await expect(insertEvent(null, 2, [first, second])).resolves.toBeDefined();
    });

    it('reads the classes of a holiday as far as the event is, and has no right to delete an event', async () => {
      const made = await added(holiday({ holidayPredefinedClassIds: [classIds[0]] }));
      const read = (societyId: string, institutionIds: string[]) =>
        database.transaction(
          { societyId, institutionIds },
          async (tx) =>
            (await sql`select 1 from event_holiday_classes where event_id = ${made.id}`.execute(tx))
              .rows.length,
        );
      expect(await read(societyA, [first])).toBe(1);
      expect(await read(societyA, [second])).toBe(0);
      expect(await read(newId(), [first])).toBe(0);
      await expect(
        database.transaction({ societyId: societyA, institutionIds: [first], roleCode: 2 }, (tx) =>
          sql`delete from events where id = ${made.id}`.execute(tx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
