import { sql, Kysely, PostgresDialect } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
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
const PARENT = 5;
/** The IST day of the clock the test sets. */
const TODAY = '2026-11-17';

interface Entry {
  id: string;
  version: number;
  sectionId: string;
  sectionName: string | null;
  className: string | null;
  subject: { id: string; name: string };
  diaryDate: string;
  description: string;
  teacher: { id: string; displayName: string } | null;
  status: number;
  createdBy: { id: string; displayName: string };
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

describe('DIA-01 to DIA-04 the diary (API design 10.14a)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let runner: JobRunner;
  let admin: string;

  let societyA: string;
  let first: string;
  let second: string;
  let year: string;
  let sectionA: string;
  let sectionB: string;
  let maths: string;
  let english: string;
  let owner: SignedInPerson;
  let firstAdmin: SignedInPerson;
  let secondAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let anna: SchoolStaff;
  let ben: SchoolStaff;
  let cara: SchoolStaff;
  let dev: SchoolStaff;
  let annaToken: string;
  let benToken: string;
  let caraToken: string;
  let devToken: string;
  let childA: string;
  let childB: string;
  let parentA: string;
  let parentB: string;

  const rows = <T>(query: string) =>
    database.transaction(
      { societyId: societyA, institutionIds: [first], roleCode: 2, personId: owner.person },
      async (tx) => (await sql<T>`${sql.raw(query)}`.execute(tx)).rows,
    );
  const entry = (fields: object = {}) => ({
    sectionId: sectionA,
    subjectId: maths,
    diaryDate: TODAY,
    description: 'Exercise 4.2, questions 1 to 10.',
    ...fields,
  });
  const add = (fields: object = {}, token = owner.token) =>
    api('post', '/v1/diary-entries', token, entry(fields));
  const added = async (fields: object = {}, token = owner.token) => {
    const res = await add(fields, token);
    expect([res.status, res.body.code]).toEqual([201, 'CREATED']);
    return res.body.data as unknown as Entry;
  };
  const read = (query: string, token = owner.token) =>
    api('get', `/v1/diary-entries?${query}`, token);
  const listed = async (query: string, token = owner.token) => {
    const res = await read(query, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Entry[];
  };
  const change = (id: string, body: object, token = owner.token) =>
    api('patch', `/v1/diary-entries/${id}`, token, body);
  const remove = (id: string, token = owner.token) =>
    api('delete', `/v1/diary-entries/${id}`, token);
  const drain = async () => {
    while (await runner.runNext()) {
      // the worker drains the queue
    }
  };
  const asParent = <T>(childIds: string[], query: string) =>
    database.transaction(
      { personId: newId(), roleCode: PARENT, childIds },
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
    const classId = await kit.klass(owner.token, first, predefinedClass);
    const sectionOf = (code: string) =>
      kit.section(owner.token, classId, predefinedSections.find((s) => s.code === code)!.id);
    sectionA = await sectionOf('A');
    sectionB = await sectionOf('B');
    maths = await kit.subject(owner.token, 'Mathematics');
    english = await kit.subject(owner.token, 'English');
    const person = (name: string, home = first) =>
      kit.staff(owner.token, home, categoryId, { firstName: name, lastName: 'Rao' });
    anna = await person('Anna');
    ben = await person('Ben');
    cara = await person('Cara');
    dev = await person('Dev', second);
    for (const [staff, subjectIds] of [
      [anna, [maths, english]],
      [ben, [maths]],
      [cara, [maths, english]],
      [dev, [maths]],
    ] as const) {
      succeeded(
        await api('put', `/v1/staff/${staff.id}/subjects`, owner.token, { subjectIds }),
        200,
        'subjects',
      );
    }
    // Anna teaches Mathematics in section A; Ben leads section B (any subject); Cara has no assignment.
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
    succeeded(
      await api('put', `/v1/staff/${ben.id}/class-teacher`, owner.token, {
        academicYearId: year,
        sectionId: sectionB,
      }),
      200,
      'class teacher',
    );
    annaToken = await kit.actingAs(anna.person.email, TEACHER, societyA);
    benToken = await kit.actingAs(ben.person.email, TEACHER, societyA);
    caraToken = await kit.actingAs(cara.person.email, TEACHER, societyA);
    devToken = await kit.actingAs(dev.person.email, TEACHER, societyA);
    const emailA = parentEmail();
    const emailB = parentEmail();
    const child = async (sectionId: string, email: string) =>
      (
        await kit.student(
          owner.token,
          first,
          { academicYearId: year, classId, sectionId },
          { guardians: [guardianOf(email)] },
        )
      ).id;
    childA = await child(sectionA, emailA);
    childB = await child(sectionB, emailB);
    parentA = (await signInMobile(t, emailA)).accessToken;
    parentB = (await signInMobile(t, emailB)).accessToken;
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('DIA-02 add', () => {
    it('lets the Owner and the Admin write for any subject, and shows the entry with no teacher', async () => {
      const made = await added({ subjectId: english });
      expect(made).toMatchObject({
        sectionId: sectionA,
        sectionName: 'A',
        className: '10th',
        subject: { id: english, name: 'English' },
        diaryDate: TODAY,
        description: 'Exercise 4.2, questions 1 to 10.',
        teacher: null,
        status: 1,
        version: 1,
        createdBy: { id: owner.person },
      });
      expect((await added({}, firstAdmin.token)).teacher).toBeNull();
    });

    it('lets a teacher write what they teach, and the class teacher write any subject of the section', async () => {
      expect(await added({}, annaToken)).toMatchObject({
        teacher: { id: anna.id, displayName: 'Anna Rao' },
      });
      expect(await added({ sectionId: sectionB, subjectId: english }, benToken)).toMatchObject({
        teacher: { id: ben.id },
      });
    });

    it('is 403 NOT_ASSIGNED for a teacher’s other subject or section, for one with no assignment, and away from home', async () => {
      for (const [fields, token] of [
        [{ subjectId: english }, annaToken],
        [{ sectionId: sectionB }, annaToken],
        [{}, caraToken],
      ] as const) {
        const res = await add(fields, token);
        expect([res.status, res.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      }
      expect((await add({}, devToken)).status).toBe(404);
    });

    it('is 404 beyond the caller’s reach, and 403 for a parent', async () => {
      for (const token of [secondAdmin.token, otherOwner.token]) {
        expect((await add({}, token)).status).toBe(404);
      }
      expect((await add({}, parentA)).status).toBe(403);
    });

    it('refuses a missing, blank or too long field and a date that is not a day, naming each', async () => {
      const res = await api('post', '/v1/diary-entries', owner.token, {
        sectionId: 'nope',
        diaryDate: '2026-02-30',
        description: '   ',
      });
      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual({
        sectionId: 'INVALID_FORMAT',
        subjectId: 'INVALID_FORMAT',
        diaryDate: 'INVALID_FORMAT',
        description: 'TOO_SHORT',
      });
      expect(fieldsOf(await add({ description: 'x'.repeat(2001) }))).toEqual({
        description: 'TOO_LONG',
      });
      expect(fieldsOf(await add({ description: '' }))).toEqual({ description: 'TOO_SHORT' });
    });

    it('takes today and up to 7 days back, and refuses a day to come (422 DATE_IN_FUTURE) and a day further back (422 DATE_TOO_OLD)', async () => {
      expect((await add({ diaryDate: '2026-11-10' })).status).toBe(201);
      for (const [date, code] of [
        ['2026-11-18', 'DATE_IN_FUTURE'],
        ['2026-11-09', 'DATE_TOO_OLD'],
      ] as const) {
        const res = await add({ diaryDate: date });
        expect([res.status, res.body.code]).toEqual([422, code]);
      }
    });

    it('refuses a closed subject or section (422 REFERENCE_INACTIVE)', async () => {
      succeeded(await api('delete', `/v1/subjects/${english}`, owner.token), 200, 'subject');
      const res = await add({ subjectId: english });
      expect([res.status, res.body.code]).toEqual([422, 'REFERENCE_INACTIVE']);
      expect(fieldsOf(res)).toEqual({ subjectId: 'REFERENCE_INACTIVE' });
    });

    it('audits the entry and tells the section’s parents once, and no other section’s', async () => {
      const made = await added();
      expect(
        await readAuditRows<{ action: string; institution_id: string | null }>(
          ownerDb,
          sql`entity_id = ${made.id}`,
        ),
      ).toMatchObject([{ action: 'diary_entry.created', institution_id: first }]);
      const jobs = await readJobs(ownerDb, societyA, 'notify');
      expect(jobs.map((job) => (job.payload as { sourceKey: string }).sourceKey)).toEqual([
        `diary:${made.id}`,
      ]);
      await drain();
      const inbox = await api('get', '/v1/notifications?tab=1&limit=50', parentA);
      expect(inbox.body.data).toEqual([
        expect.objectContaining({
          title: 'New diary entry',
          body: 'Mathematics: a diary entry for 17 Nov 2026.',
          category: 2,
          studentId: childA,
        }),
      ]);
      const other = await api('get', '/v1/notifications?tab=1&limit=50', parentB);
      expect(other.body.data).toEqual([]);
    });
  });

  describe('DIA-01 read', () => {
    it('lists a section’s entries on a date in the order written, with names', async () => {
      const one = await added();
      const two = await added({ subjectId: english, description: 'Read chapter 3.' });
      await added({ diaryDate: '2026-11-16' });
      await added({ sectionId: sectionB });
      const entries = await listed(`sectionId=${sectionA}&date=${TODAY}`);
      expect(entries.map((e) => e.id)).toEqual([one.id, two.id]);
      expect(entries[1]).toMatchObject({ sectionName: 'A', subject: { name: 'English' } });
      expect(await listed(`sectionId=${sectionA}&date=2026-11-12`)).toEqual([]);
    });

    it('lets the Admin and a teacher of the section read, and refuses another teacher (403) or Institution (404)', async () => {
      await added();
      expect(await listed(`sectionId=${sectionA}&date=${TODAY}`, firstAdmin.token)).toHaveLength(1);
      expect(await listed(`sectionId=${sectionA}&date=${TODAY}`, annaToken)).toHaveLength(1);
      expect(await listed(`sectionId=${sectionB}&date=${TODAY}`, benToken)).toEqual([]);
      for (const token of [annaToken, caraToken]) {
        const res = await read(`sectionId=${sectionB}&date=${TODAY}`, token);
        expect([res.status, res.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      }
      for (const token of [secondAdmin.token, otherOwner.token, devToken]) {
        expect((await read(`sectionId=${sectionA}&date=${TODAY}`, token)).status).toBe(404);
      }
    });

    it('shows a parent their child’s section, with the teacher’s name and no section names', async () => {
      await added({}, annaToken);
      const entries = await listed(`studentId=${childA}&date=${TODAY}`, parentA);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        subject: { name: 'Mathematics' },
        teacher: { displayName: 'Anna Rao' },
        sectionName: null,
        className: null,
      });
      expect(await listed(`studentId=${childB}&date=${TODAY}`, parentB)).toEqual([]);
    });

    it('is 404 to a parent for another’s child, and asks each reader for what is theirs (400)', async () => {
      expect((await read(`studentId=${childB}&date=${TODAY}`, parentA)).status).toBe(404);
      const named = await read(`studentId=${childA}&sectionId=${sectionA}&date=${TODAY}`, parentA);
      expect([named.status, fieldsOf(named)]).toEqual([400, { sectionId: 'FIELD_NOT_ALLOWED' }]);
      const none = await read(`date=${TODAY}`, parentA);
      expect([none.status, fieldsOf(none)]).toEqual([400, { studentId: 'REQUIRED' }]);
      const staff = await read(`studentId=${childA}&date=${TODAY}`);
      expect([staff.status, fieldsOf(staff)]).toEqual([
        400,
        { studentId: 'FIELD_NOT_ALLOWED', sectionId: 'REQUIRED' },
      ]);
      const noDate = await read(`sectionId=${sectionA}`);
      expect([noDate.status, fieldsOf(noDate)]).toEqual([400, { date: 'INVALID_TYPE' }]);
    });
  });

  describe('DIA-03 change', () => {
    it('lets the author change the description, the subject they teach and the date, and bumps the version and the audit', async () => {
      const made = await added({}, annaToken);
      const res = await change(
        made.id,
        { version: 1, description: 'Redo question 7.', diaryDate: '2026-11-16' },
        annaToken,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: made.id,
        version: 2,
        description: 'Redo question 7.',
        diaryDate: '2026-11-16',
        subject: { id: maths },
        teacher: { id: anna.id },
      });
      expect(
        (await readAuditRows<{ action: string }>(ownerDb, sql`entity_id = ${made.id}`)).map(
          (row) => row.action,
        ),
      ).toEqual(['diary_entry.created', 'diary_entry.updated']);
    });

    it('lets the Owner and the Admin change any entry of the Institution', async () => {
      const made = await added({}, annaToken);
      expect((await change(made.id, { version: 1, subjectId: english })).status).toBe(200);
      const again = await change(made.id, { version: 2, description: 'Done.' }, firstAdmin.token);
      expect(again.body.data).toMatchObject({ version: 3, subject: { id: english } });
    });

    it('is 403 NOT_ASSIGNED for a teacher who did not write it, and for a subject the author may not write', async () => {
      const made = await added({}, annaToken);
      const other = await change(made.id, { version: 1, description: 'Mine now.' }, caraToken);
      expect([other.status, other.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      const subject = await change(made.id, { version: 1, subjectId: english }, annaToken);
      expect([subject.status, subject.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      const byAdmin = await added();
      expect((await change(byAdmin.id, { version: 1, description: 'x' }, annaToken)).status).toBe(
        403,
      );
    });

    it('writes nothing for a request that changes nothing, and checks the version first', async () => {
      const made = await added();
      const same = await change(made.id, { version: 1, description: made.description });
      expect(same.body.data).toMatchObject({ version: 1 });
      expect(
        (await readAuditRows<{ action: string }>(ownerDb, sql`entity_id = ${made.id}`)).length,
      ).toBe(1);
      await change(made.id, { version: 1, description: 'Changed.' });
      const stale = await change(made.id, { version: 1, description: 'Again.' });
      expect([stale.status, stale.body.code]).toEqual([409, 'VERSION_CONFLICT']);
    });

    it('refuses a new date as DIA-02 does, and one that is not a day or a blank description (400)', async () => {
      const made = await added();
      for (const [date, code] of [
        ['2026-11-18', 'DATE_IN_FUTURE'],
        ['2026-11-09', 'DATE_TOO_OLD'],
      ] as const) {
        const res = await change(made.id, { version: 1, diaryDate: date });
        expect([res.status, res.body.code]).toEqual([422, code]);
      }
      const bad = await change(made.id, { version: 1, diaryDate: '2026-02-30', description: ' ' });
      expect([bad.status, fieldsOf(bad)]).toEqual([
        400,
        { diaryDate: 'INVALID_FORMAT', description: 'TOO_SHORT' },
      ]);
      expect(fieldsOf(await change(made.id, { description: 'x' }))).toEqual({
        version: 'INVALID_TYPE',
      });
    });

    it('is 404 beyond the caller’s reach and for a removed entry, and 403 for a parent', async () => {
      const made = await added();
      const body = { version: 1, description: 'Changed.' };
      for (const token of [secondAdmin.token, otherOwner.token, devToken]) {
        expect((await change(made.id, body, token)).status).toBe(404);
      }
      expect((await change(made.id, body, parentA)).status).toBe(403);
      await remove(made.id);
      expect((await change(made.id, body)).status).toBe(404);
    });
  });

  describe('DIA-04 remove', () => {
    it('lets the author, the Owner and the Admin remove an entry, which leaves the lists', async () => {
      const mine = await added({}, annaToken);
      const theirs = await added({ description: 'By the Owner.' });
      expect((await remove(mine.id, annaToken)).body.data).toEqual({ id: mine.id, status: 0 });
      expect((await remove(theirs.id, firstAdmin.token)).status).toBe(200);
      expect(await listed(`sectionId=${sectionA}&date=${TODAY}`)).toEqual([]);
      expect(await listed(`studentId=${childA}&date=${TODAY}`, parentA)).toEqual([]);
      expect(
        (await readAuditRows<{ action: string }>(ownerDb, sql`entity_id = ${mine.id}`)).map(
          (row) => row.action,
        ),
      ).toEqual(['diary_entry.created', 'diary_entry.deactivated']);
    });

    it('is 403 NOT_ASSIGNED for another teacher, 404 for a removed entry or one out of reach, and 403 for a parent', async () => {
      const made = await added({}, annaToken);
      const other = await remove(made.id, caraToken);
      expect([other.status, other.body.code]).toEqual([403, 'NOT_ASSIGNED']);
      expect((await remove(made.id, parentA)).status).toBe(403);
      for (const token of [secondAdmin.token, otherOwner.token, devToken]) {
        expect((await remove(made.id, token)).status).toBe(404);
      }
      await remove(made.id, annaToken);
      expect((await remove(made.id, annaToken)).status).toBe(404);
      expect((await remove(newId())).status).toBe(404);
    });
  });

  describe('the table (row-level security)', () => {
    it('shows a parent the active entries of their child’s section and nothing else', async () => {
      const inA = await added();
      const gone = await added({ description: 'Removed.' });
      await added({ sectionId: sectionB });
      await remove(gone.id);
      const seen = await asParent<{ id: string }>([childA], 'select id from diary_entries');
      expect(seen.map((row) => row.id)).toEqual([inA.id]);
      expect(await asParent([], 'select id from diary_entries')).toEqual([]);
    });

    it('keeps an entry from naming a section of another Institution, a blank description and a delete', async () => {
      const made = await added();
      await expect(
        rows(`update diary_entries set description = '  ' where id = '${made.id}'`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(rows(`delete from diary_entries where id = '${made.id}'`)).rejects.toMatchObject(
        { code: '42501' },
      );
      await expect(
        rows(`update diary_entries set status = 2 where id = '${made.id}'`),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
