import { Kysely, PostgresDialect } from 'kysely';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { JobRunner } from '../../src/platform/jobs/index.js';
import { PushSender } from '../../src/platform/notifications/index.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import * as blocks from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, succeeded, type StudentPlace } from '../support/school-kit.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');

const mail = () => `${Math.random().toString(36).slice(2)}@parent.test`;
const guardian = (email: string) => ({
  firstName: 'Ravi',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  email,
  isPrimary: true,
  isEmergencyContact: true,
});

interface Event {
  id: string;
  title: string;
  canEdit: boolean;
}

interface Item {
  title: string;
  body: string;
  tab: number;
  category: number;
  target: { type: number; id: string } | null;
}

const holiday = (fields: object = {}) => ({
  isHoliday: true,
  holidayType: 3,
  holidayForStudents: true,
  ...fields,
});

/**
 * The notice to the audience of an event (EVT-02, EVT-04) and a parent's read of the calendar of their own child
 * (EVT-01, EVT-03), PRD 7.12, API design 10.26.
 */
describe('who an event reaches, and what a parent reads of the calendar', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let runner: JobRunner;
  let sender: PushSender;
  let admin: string;
  let societyId: string;

  /** Society A: two Institutions. The first has classes 9 and 10, a teacher and an Admin; the second an Admin and a student. */
  let owner: SignedInPerson;
  let firstAdmin: SignedInPerson;
  let secondAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let teacher: string;
  let first: string;
  let second: string;
  let classTen: string;
  let classNine: string;
  /** The parents of the student in class 10, of the one in class 9, of the second Institution's, and of a stranger's. */
  const parents: Record<'ten' | 'nine' | 'second' | 'both' | 'stranger', string> = {
    ten: '',
    nine: '',
    second: '',
    both: '',
    stranger: '',
  };
  const students: Record<
    'ten' | 'nine' | 'second' | 'bothFirst' | 'bothSecond' | 'stranger',
    string
  > = {
    ten: '',
    nine: '',
    second: '',
    bothFirst: '',
    bothSecond: '',
    stranger: '',
  };
  const tokens: Record<string, string> = {};

  const body = (fields: object = {}) => ({
    title: 'Annual Day',
    startDate: '2026-12-22',
    endDate: '2026-12-24',
    durationLabel: '3 Days',
    scope: 2,
    institutionId: first,
    ...fields,
  });
  const create = async (fields: object = {}, token = owner.token) => {
    const res = succeeded(await api('post', '/v1/events', token, body(fields)), 201, 'event');
    await drain();
    return res.body.data as unknown as Event;
  };
  const drain = async () => {
    while (await runner.runNext()) {
      // the worker drains the queue
    }
  };
  const inbox = async (token: string) => {
    const tabs = await Promise.all(
      [2, 3, 4].map((tab) =>
        api('get', `/v1/notifications?tab=${tab.toString()}&limit=100`, token),
      ),
    );
    expect(tabs.map((r) => r.status)).toEqual([200, 200, 200]);
    return tabs.flatMap((r) => r.body.data as unknown as Item[]);
  };
  /** Who has a notice with this title in their inbox. */
  const reached = async (title: string) => {
    const names: string[] = [];
    for (const [name, token] of Object.entries(tokens)) {
      if ((await inbox(token)).some((item) => item.title === title)) names.push(name);
    }
    return names.toSorted();
  };
  const read = (query: string, token: string) => api('get', `/v1/events?${query}`, token);
  const span = 'from=2026-12-01&to=2026-12-31';
  const titles = async (studentId: string, token: string, extra = '') => {
    const res = await read(`${span}&studentId=${studentId}${extra}`, token);
    expect(res.status).toBe(200);
    return (res.body.data as unknown as Event[]).map((e) => e.title).toSorted();
  };

  const seen = (childIds: string[], roleCode = 5) =>
    database.transaction({ personId: owner.person, roleCode, childIds }, async (tx) =>
      (await tx.selectFrom('events').select('title').orderBy('title').execute()).map(
        (e) => e.title,
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
    runner = t.app.get(JobRunner);
    sender = t.app.get(PushSender, { strict: false });
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    vi.spyOn(sender, 'send').mockImplementation((messages) =>
      Promise.resolve(messages.map(() => 'sent' as const)),
    );
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    const categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    const predefined = await kit.masters(admin, 'predefined-classes');
    const sections = await kit.masters(admin, 'predefined-sections');
    societyId = await kit.society(admin);
    owner = await fixtures.owner(societyId);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    firstAdmin = await fixtures.institutionAdmin(societyId, [first]);
    secondAdmin = await fixtures.institutionAdmin(societyId, [second]);
    otherOwner = await fixtures.owner(await kit.society(admin));
    const placeIn = async (
      institutionId: string,
      code: string,
      year?: string,
    ): Promise<[StudentPlace, string]> => {
      const academicYearId = year ?? (await kit.year(owner.token, institutionId));
      const predefinedId = predefined.find((c) => c.code === code)!.id;
      const classId = await kit.klass(owner.token, institutionId, predefinedId);
      const sectionId = await kit.section(
        owner.token,
        classId,
        sections.find((c) => c.code === 'A')!.id,
      );
      return [{ academicYearId, classId, sectionId }, predefinedId];
    };
    const [placeTen, predefinedTen] = await placeIn(first, 'C10');
    classTen = predefinedTen;
    const [placeNine, predefinedNine] = await placeIn(first, 'C09', placeTen.academicYearId);
    classNine = predefinedNine;
    const [placeSecond] = await placeIn(second, 'C09');
    parents.ten = mail();
    parents.nine = mail();
    parents.second = mail();
    parents.both = mail();
    parents.stranger = mail();
    const student = async (
      token: string,
      place: StudentPlace,
      institutionId: string,
      email: string,
      name: string,
    ) =>
      (
        await kit.student(token, institutionId, place, {
          firstName: name,
          guardians: [guardian(email)],
        })
      ).id;
    students.ten = await student(owner.token, placeTen, first, parents.ten, 'Ten');
    students.nine = await student(owner.token, placeNine, first, parents.nine, 'Nine');
    students.second = await student(owner.token, placeSecond, second, parents.second, 'Second');
    students.bothFirst = await student(owner.token, placeNine, first, parents.both, 'BothFirst');
    students.bothSecond = await student(
      owner.token,
      placeSecond,
      second,
      parents.both,
      'BothSecond',
    );
    const strangerOwner = otherOwner;
    const strangerInstitution = await kit.institution(strangerOwner.token, categoryId);
    const strangerYear = await kit.year(strangerOwner.token, strangerInstitution);
    const strangerClass = await kit.klass(
      strangerOwner.token,
      strangerInstitution,
      predefined.find((c) => c.code === 'C09')!.id,
    );
    const strangerSection = await kit.section(
      strangerOwner.token,
      strangerClass,
      sections.find((c) => c.code === 'A')!.id,
    );
    students.stranger = await student(
      strangerOwner.token,
      { academicYearId: strangerYear, classId: strangerClass, sectionId: strangerSection },
      strangerInstitution,
      parents.stranger,
      'Stranger',
    );
    const staff = await kit.staff(owner.token, first, categoryId);
    teacher = await kit.actingAs(staff.person.email, 4, societyId);
    tokens.teacher = teacher;
    tokens.firstAdmin = firstAdmin.token;
    tokens.secondAdmin = secondAdmin.token;
    tokens.owner = owner.token;
    tokens.otherOwner = otherOwner.token;
    for (const [key, email] of Object.entries(parents)) {
      tokens[`parent-${key}`] = (await signInMobile(t, email)).accessToken;
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await blocks.clearBlocks(ownerDb);
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('the notice to the audience', () => {
    it('tells everyone of an Institution event: its staff and its parents, not the other Institution, another Society or the one who made it', async () => {
      const made = await create({ title: 'Annual Day' });
      expect(await reached('New event: Annual Day')).toEqual([
        'firstAdmin',
        'parent-both',
        'parent-nine',
        'parent-ten',
        'teacher',
      ]);
      const [item] = (await inbox(tokens.teacher!)).filter(
        (i) => i.title === 'New event: Annual Day',
      );
      expect(item).toMatchObject({
        body: '22 Dec 2026 to 24 Dec 2026',
        tab: 2,
        category: 3,
        target: { type: 3, id: made.id },
      });
    });

    it('tells the whole Society of a Society event, the Owner who made it excepted', async () => {
      await create({ scope: 1, institutionId: undefined, title: 'Founders Day' });
      expect(await reached('New event: Founders Day')).toEqual([
        'firstAdmin',
        'parent-both',
        'parent-nine',
        'parent-second',
        'parent-ten',
        'secondAdmin',
        'teacher',
      ]);
    });

    it('tells parents alone of an event for students and parents, and staff alone of one for staff, each in its own tab', async () => {
      await create({ title: 'Parents Evening', audience: 2 });
      expect(await reached('New event: Parents Evening')).toEqual([
        'parent-both',
        'parent-nine',
        'parent-ten',
      ]);
      await create({ title: 'Staff Meeting', audience: 3 });
      expect(await reached('New event: Staff Meeting')).toEqual(['firstAdmin', 'teacher']);
      const families = (await api('get', '/v1/notifications?tab=4', tokens['parent-ten']!)).body
        .data as unknown as Item[];
      expect(families.map((i) => i.title)).toEqual(['New event: Parents Evening']);
      const staffTab = (await api('get', '/v1/notifications?tab=3', tokens.teacher!)).body
        .data as unknown as Item[];
      expect(staffTab.map((i) => i.title)).toEqual(['New event: Staff Meeting']);
    });

    it('limits the parents of a holiday to the classes it is for, and tells the staff of it', async () => {
      await create(holiday({ title: 'Class 9 Holiday', holidayPredefinedClassIds: [classNine] }));
      expect(await reached('Holiday: Class 9 Holiday')).toEqual([
        'firstAdmin',
        'parent-both',
        'parent-nine',
        'teacher',
      ]);
      await create(
        holiday({ title: 'Classes 9 and 10', holidayPredefinedClassIds: [classTen, classNine] }),
      );
      expect(await reached('Holiday: Classes 9 and 10')).toEqual([
        'firstAdmin',
        'parent-both',
        'parent-nine',
        'parent-ten',
        'teacher',
      ]);
    });

    it('leaves the parents out of a holiday for staff alone', async () => {
      await create({
        title: 'Staff Holiday',
        isHoliday: true,
        holidayType: 4,
        holidayForStaff: true,
      });
      expect(await reached('Holiday: Staff Holiday')).toEqual(['firstAdmin', 'teacher']);
    });

    it('tells the Owner of an event an Admin made, and not the Admin', async () => {
      await create({ title: 'By Admin' }, firstAdmin.token);
      expect(await reached('New event: By Admin')).toEqual(
        ['parent-both', 'parent-nine', 'parent-ten', 'teacher', 'owner'].toSorted(),
      );
    });

    it('tells of a change as an update, once for each change, and of a request that changes nothing not at all', async () => {
      const made = await create({ title: 'Annual Day' });
      const edit = async (fields: object, version: number) => {
        succeeded(
          await api('patch', `/v1/events/${made.id}`, owner.token, { version, ...fields }),
          200,
          'edit',
        );
        await drain();
      };
      await edit({ title: 'Annual Day 2026' }, 1);
      expect(await reached('Updated: Annual Day 2026')).toEqual([
        'firstAdmin',
        'parent-both',
        'parent-nine',
        'parent-ten',
        'teacher',
      ]);
      await edit({ title: 'Annual Day 2026' }, 2);
      const mine = (await inbox(tokens.teacher!)).filter((i) => i.title.startsWith('Updated'));
      expect(mine).toHaveLength(1);
      await edit({ venue: 'Main Hall' }, 2);
      expect(
        (await inbox(tokens.teacher!)).filter((i) => i.title.startsWith('Updated')),
      ).toHaveLength(2);
    });

    it('tells nobody of a deactivated event or a moved scope, and nothing of an event that fails to be made', async () => {
      const made = await create({ title: 'Annual Day' });
      const before = (await inbox(tokens.teacher!)).length;
      succeeded(
        await api('post', `/v1/events/${made.id}/scope`, owner.token, { version: 1, scope: 1 }),
        200,
        'scope',
      );
      succeeded(await api('delete', `/v1/events/${made.id}`, owner.token), 200, 'delete');
      const refused = await api('post', '/v1/events', owner.token, body({ endDate: '2026-12-01' }));
      expect(refused.status).toBe(400);
      await drain();
      expect((await inbox(tokens.teacher!)).length).toBe(before);
    });

    it('sends the push with the title and the days only', async () => {
      const send = vi.spyOn(sender, 'send');
      const register = await api('put', '/v1/me/push-device', tokens.teacher!, {
        fcmToken: 'events-teacher',
        platform: 1,
      });
      expect(register.status).toBe(200);
      await create({ title: 'Annual Day', venue: 'Main Hall' });
      const messages = send.mock.calls.flatMap(([batch]) => batch);
      expect(messages).toEqual([
        expect.objectContaining({
          token: 'events-teacher',
          title: 'New event: Annual Day',
          body: '22 Dec 2026 to 24 Dec 2026 at Main Hall',
        }),
      ]);
      expect(JSON.stringify(messages)).not.toContain(first);
    });
  });

  describe('a parent reads the calendar of their own child', () => {
    beforeEach(async () => {
      await create({ title: 'Everyone', audience: 1 });
      await create({ title: 'Families', audience: 2 });
      await create({ title: 'Staff', audience: 3 });
      await create({ title: 'Other Institution', institutionId: second });
      await create({ scope: 1, institutionId: undefined, title: 'Society', audience: 1 });
      await create(holiday({ title: 'Student Holiday', institutionId: first }));
      await create({
        title: 'Staff Holiday',
        isHoliday: true,
        holidayType: 4,
        holidayForStaff: true,
      });
    });

    it('lists the events of their child’s Institution and the Society’s for the audiences of parents, with no holiday for staff alone', async () => {
      expect(await titles(students.ten, tokens['parent-ten']!)).toEqual([
        'Everyone',
        'Families',
        'Society',
        'Student Holiday',
      ]);
      expect(await titles(students.ten, tokens['parent-ten']!, '&holidays=true')).toEqual([
        'Student Holiday',
      ]);
    });

    it('reads each child of one parent in that child’s own Institution', async () => {
      const token = tokens['parent-both']!;
      expect(await titles(students.bothFirst, token)).toEqual([
        'Everyone',
        'Families',
        'Society',
        'Student Holiday',
      ]);
      expect(await titles(students.bothSecond, token)).toEqual(['Other Institution', 'Society']);
    });

    it('says a parent may not edit what they read, and shows the dates and the holiday classes', async () => {
      const res = await read(
        `${span}&studentId=${students.nine}&holidays=true`,
        tokens['parent-nine']!,
      );
      expect((res.body.data as unknown as Event[]).every((e) => !e.canEdit)).toBe(true);
    });

    it('is 404 for a child who is not theirs, 400 without a child, and 400 for an Institution or a year', async () => {
      const token = tokens['parent-ten']!;
      expect((await read(`${span}&studentId=${students.nine}`, token)).status).toBe(404);
      expect((await read(`${span}&studentId=${students.stranger}`, token)).status).toBe(404);
      const none = await read(span, token);
      expect([none.status, none.body.errors?.[0]]).toEqual([
        400,
        expect.objectContaining({ field: 'studentId', code: 'REQUIRED' }),
      ]);
      const more = await read(`${span}&studentId=${students.ten}&institutionId=${first}`, token);
      expect(more.body.errors?.[0]).toMatchObject({
        field: 'institutionId',
        code: 'FIELD_NOT_ALLOWED',
      });
    });

    it('stops at a blocked child and at blocked students of the Institution, for that child only', async () => {
      const token = tokens['parent-both']!;
      succeeded(
        await api('post', `/v1/students/${students.bothFirst}/block`, owner.token, {}),
        200,
        'block',
      );
      const refused = await read(`${span}&studentId=${students.bothFirst}`, token);
      expect([refused.status, refused.body.code]).toEqual([403, 'CHILD_ACCESS_BLOCKED']);
      expect((await read(`${span}&studentId=${students.bothSecond}`, token)).status).toBe(200);
      await blocks.setBlock(ownerDb, societyId, second, 3, true);
      expect((await read(`${span}&studentId=${students.bothSecond}`, token)).status).toBe(423);
    });

    it('reads one event of their child’s calendar, and is 404 for a staff event, another Institution’s and a deactivated one', async () => {
      const list = async (studentId: string, token: string) =>
        (await read(`${span}&studentId=${studentId}`, token)).body.data as unknown as Event[];
      const token = tokens['parent-ten']!;
      const everyone = (await list(students.ten, token)).find((e) => e.title === 'Everyone')!;
      const one = await api('get', `/v1/events/${everyone.id}?studentId=${students.ten}`, token);
      expect(one.status).toBe(200);
      expect(one.body.data).toMatchObject({ id: everyone.id, canEdit: false });
      expect((await api('get', `/v1/events/${everyone.id}`, token)).status).toBe(400);
      const staffOnly = (await api('get', `/v1/events?${span}`, owner.token)).body
        .data as unknown as Event[];
      const idOf = (title: string) => staffOnly.find((e) => e.title === title)!.id;
      for (const title of ['Staff', 'Other Institution', 'Staff Holiday']) {
        const res = await api('get', `/v1/events/${idOf(title)}?studentId=${students.ten}`, token);
        expect(res.status).toBe(404);
      }
      succeeded(await api('delete', `/v1/events/${everyone.id}`, owner.token), 200, 'delete');
      expect(
        (await api('get', `/v1/events/${everyone.id}?studentId=${students.ten}`, token)).status,
      ).toBe(404);
    });

    it('is refused every change, and a staff caller may not name a child', async () => {
      const token = tokens['parent-ten']!;
      const [one] = (await read(`${span}&studentId=${students.ten}`, token)).body
        .data as unknown as Event[];
      expect((await api('post', '/v1/events', token, body())).status).toBe(403);
      expect(
        (await api('patch', `/v1/events/${one!.id}`, token, { version: 1, title: 'x' })).status,
      ).toBe(403);
      expect((await api('delete', `/v1/events/${one!.id}`, token)).status).toBe(403);
      expect(
        (await api('post', `/v1/events/${one!.id}/scope`, token, { version: 1, scope: 1 })).status,
      ).toBe(403);
      const staff = await read(`${span}&studentId=${students.ten}`, owner.token);
      expect(staff.body.errors?.[0]).toMatchObject({
        field: 'studentId',
        code: 'FIELD_NOT_ALLOWED',
      });
    });
  });

  describe('row-level security, as the app role', () => {
    it('shows a parent’s request only the events for parents of its child’s Society and Institution, and no one else’s', async () => {
      await create({ title: 'Everyone', audience: 1 });
      await create({ title: 'Staff', audience: 3 });
      await create({ title: 'Other Institution', institutionId: second });
      expect(await seen([students.ten])).toEqual(['Everyone']);
      expect(await seen([students.second])).toEqual(['Other Institution']);
      expect(await seen([students.ten, students.second])).toEqual([
        'Everyone',
        'Other Institution',
      ]);
      expect(await seen([students.stranger])).toEqual([]);
      expect(await seen([])).toEqual([]);
      // A Society-wide event of another Society has no Institution to compare, so the Society must be.
      await create(
        { title: 'Other Society', scope: 1, institutionId: undefined },
        otherOwner.token,
      );
      expect(await seen([students.ten])).toEqual(['Everyone']);
      expect(await seen([students.stranger])).toEqual(['Other Society']);
      // An event that was deactivated is not seen.
      const gone = await create({ title: 'Cancelled', audience: 1 });
      succeeded(
        await api('delete', `/v1/events/${gone.id}`, owner.token),
        200,
        'deactivated event',
      );
      expect(await seen([students.ten])).toEqual(['Everyone']);
      // The setting of a child is honoured for role 5 only.
      expect(await seen([students.ten], 4)).toEqual([]);
    });

    it('lets a parent read the classes of a holiday as far as they read the holiday, and write nothing', async () => {
      const made = await create(
        holiday({ title: 'Class 9 Holiday', holidayPredefinedClassIds: [classNine] }),
      );
      const classes = (childIds: string[]) =>
        database.transaction(
          { personId: owner.person, roleCode: 5, childIds },
          async (tx) =>
            (await tx.selectFrom('event_holiday_classes').select('event_id').execute()).length,
        );
      expect(await classes([students.nine])).toBe(1);
      expect(await classes([students.second])).toBe(0);
      await expect(
        database.transaction(
          { personId: owner.person, roleCode: 5, childIds: [students.nine] },
          (tx) => tx.updateTable('events').set({ title: 'x' }).where('id', '=', made.id).execute(),
        ),
      ).resolves.toBeDefined();
      const after = await api('get', `/v1/events?${span}`, owner.token);
      expect((after.body.data as unknown as Event[]).map((e) => e.title)).toEqual([
        'Class 9 Holiday',
      ]);
    });
  });
});
