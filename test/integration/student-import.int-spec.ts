import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { IMPORT_HEADER } from '../../src/modules/people/import.csv.js';
import { StudentService } from '../../src/modules/people/student.service.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { JobRunner } from '../../src/platform/jobs/index.js';
import { JobsRepository } from '../../src/platform/jobs/jobs.repository.js';
import { MAX_ATTEMPTS } from '../../src/platform/jobs/jobs.rules.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { changeJobs, readJobs } from '../support/job-rows.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, succeeded, type StudentPlace } from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;
const HEADER = IMPORT_HEADER.join(',');

interface Ticket {
  fileId: string;
  upload: { url: string; fields: Record<string, string> };
}
interface RunBody {
  id: string;
  kind: string;
  runStatus: number;
  institutionId: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: {
    totalRows: number | null;
    processedRows: number;
    importedRows: number;
    skippedRows: number;
    overCapacity: boolean;
    summary: string;
    rowErrors: { row: number; message: string }[];
  };
  error: { code: string; message: string } | null;
}
interface StudentBody {
  id: string;
  firstName: string;
  lastName: string | null;
  mobile: unknown;
  placement: { sectionId: string; rollNumber: string; classId: string; academicYearId: string };
  guardians: {
    firstName: string;
    lastName: string | null;
    relation: number;
    email: string | null;
    isPrimary: boolean;
    hasLogin: boolean;
    phone: { countryCode: string; number: string };
  }[];
}

/** A row of the file: `Name,RollNumber,Class,Section,GuardianName,GuardianPhone,GuardianEmail`. */
const row = (name: string, roll: string, email = '', klass = '9th', section = 'A') =>
  `${name},${roll},${klass},${section},Meera Rao,98765${roll.padStart(5, '0')},${email}`;
const csv = (...rows: string[]) => Buffer.from([HEADER, ...rows].join('\r\n'));

/** The student CSV import and the worker that settles it (API design 10.8, 16.2, SDD 11.2). */
describe('student CSV import', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let runner: JobRunner;
  let admin: string;
  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let societyId: string;
  let first: string;
  let second: string;
  let categoryId: string;
  let place: StudentPlace;
  let placeAtSecond: StudentPlace;
  let predefinedSectionB: string;

  const post = (path: string, token: string, body: object, key: string | null = randomUUID()) => {
    let req = request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`);
    if (key !== null) req = req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const ticket = async (bytes: Buffer, fields: object = {}, token = owner.token) => {
    const res = await api('post', '/v1/files/uploads', token, {
      purpose: 12,
      institutionId: first,
      contentType: 'text/csv',
      sizeBytes: bytes.length,
      fileName: 'students.csv',
      ...fields,
    });
    return succeeded(res, 201, 'upload ticket').body.data as unknown as Ticket;
  };
  const send = (given: Ticket, bytes: Buffer, type = 'text/csv') => {
    const req = request(t.app.getHttpServer()).post(new URL(given.upload.url).pathname);
    for (const [name, value] of Object.entries(given.upload.fields)) req.field(name, value);
    return req.attach('file', bytes, { filename: 'upload', contentType: type });
  };
  /** A Ready import file, uploaded and confirmed by `token`. */
  const readyFile = async (bytes: Buffer, fields: object = {}, token = owner.token) => {
    const given = await ticket(bytes, fields, token);
    expect((await send(given, bytes)).status).toBe(204);
    succeeded(await api('post', `/v1/files/${given.fileId}/confirm`, token), 200, 'confirm');
    return given.fileId;
  };
  const startBody = (fileId: string, fields: object = {}) => ({
    institutionId: first,
    importType: 1,
    fileId,
    academicYearId: place.academicYearId,
    ...fields,
  });
  const start = (fileId: string, fields: object = {}, token = owner.token) =>
    post('/v1/imports', token, startBody(fileId, fields));
  const status = async (id: string, token = owner.token) => {
    const res = await api('get', `/v1/imports/${id}`, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as RunBody;
  };
  /** Uploads the file, starts the import and lets the worker settle it. */
  const importFile = async (bytes: Buffer, token = owner.token) => {
    const res = await start(await readyFile(bytes, {}, token), {}, token);
    expect(res.status).toBe(202);
    const id = res.body.data.importId as string;
    while (await runner.runNext()) {
      // the worker drains the queue
    }
    return status(id, token);
  };
  const students = async (institutionId = first) => {
    const res = await api(
      'get',
      `/v1/students?institutionId=${institutionId}&limit=100`,
      owner.token,
    );
    expect(res.status).toBe(200);
    return res.body.data as unknown as { id: string; firstName: string }[];
  };
  const studentCount = async () => {
    const res = await api('get', `/v1/students?institutionId=${first}&limit=1`, owner.token);
    return (res.body.meta as { totalItems: number }).totalItems;
  };
  const profile = async (id: string) =>
    (await api('get', `/v1/students/${id}`, owner.token)).body.data as unknown as StudentBody;
  /** How far the worker has settled a run: its status and the rows it has finished. */
  const progress = async (id: string) => {
    const run = await status(id);
    return { run_status: run.runStatus, processed_rows: run.result.processedRows };
  };
  const audit = async (entityId: string) =>
    (
      await readAuditRows<{ action: string; institution_id: string | null; new_values: unknown }>(
        ownerDb,
        sql`entity_id = ${entityId}`,
      )
    ).map((e) => ({ action: e.action, institutionId: e.institution_id, after: e.new_values }));

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
    runner = t.app.get(JobRunner);
    fixtures = new PlatformFixtures(t, ownerDb);
    api = apiCaller(t);
    kit = new SchoolKit(t, api);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    const classes = await kit.masters(admin, 'predefined-classes');
    const sectionCodes = await kit.masters(admin, 'predefined-sections');
    predefinedSectionB = sectionCodes.find((s) => s.code === 'B')!.id;
    societyId = await kit.society(admin);
    owner = await fixtures.owner(societyId);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    institutionAdmin = await fixtures.institutionAdmin(societyId, [first]);
    const placeAt = async (institutionId: string): Promise<StudentPlace> => {
      const academicYearId = await kit.year(owner.token, institutionId);
      const classId = await kit.klass(
        owner.token,
        institutionId,
        classes.find((c) => c.code === 'C09')!.id,
      );
      const sectionId = await kit.section(
        owner.token,
        classId,
        sectionCodes.find((s) => s.code === 'A')!.id,
      );
      return { academicYearId, classId, sectionId };
    };
    place = await placeAt(first);
    placeAtSecond = await placeAt(second);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  const sample = (token: string) =>
    request(t.app.getHttpServer())
      .get('/v1/imports/templates/students')
      .set('Authorization', `Bearer ${token}`);

  describe('IMP-01 the sample file', () => {
    it('sends the header and two rows as text/csv, outside the envelope', async () => {
      const res = await request(t.app.getHttpServer())
        .get('/v1/imports/templates/students')
        .set('Authorization', `Bearer ${owner.token}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toContain('students-import-sample.csv');
      expect(res.text.split('\r\n')[0]).toBe(HEADER);
      expect(res.text.trim().split('\r\n')).toHaveLength(3);
    });

    it('is open to an Institution Admin and closed to a Teacher', async () => {
      expect((await sample(institutionAdmin.token)).status).toBe(200);
      const staff = await kit.staff(owner.token, first, categoryId);
      const teacher = await kit.actingAs(staff.person.email, TEACHER, societyId, '10.0.0.7');
      expect((await sample(teacher)).status).toBe(403);
    });

    it('is a file the importer takes as it is', async () => {
      const file = await sample(owner.token);
      const run = await importFile(Buffer.from(file.text));
      // The sample names the 5th class, which this Institution does not run: both rows are skipped, none breaks the run.
      expect(run.runStatus).toBe(3);
      expect(run.result).toMatchObject({ totalRows: 2, skippedRows: 2, importedRows: 0 });
    });
  });

  describe('IMP-02 start', () => {
    it('answers 202 with the run to poll, a Location and Retry-After, queues one job and audits it', async () => {
      const fileId = await readyFile(csv(row('Asha Rao', '1')));
      const res = await start(fileId);
      expect(res.status).toBe(202);
      expect(res.body.data).toEqual({ importId: expect.any(String), runStatus: 1 });
      expect(res.headers.location).toBe(`/v1/imports/${res.body.data.importId}`);
      expect(res.headers['retry-after']).toBe('2');
      const jobs = await readJobs(ownerDb, societyId, 'students.import');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        job_status: 1,
        institution_id: first,
        created_by: owner.person,
        payload: { importRunId: res.body.data.importId, roleCode: 2 },
      });
      expect(await audit(res.body.data.importId as string)).toContainEqual({
        action: 'import.started',
        institutionId: first,
        after: null,
      });
      const run = await status(res.body.data.importId as string);
      expect(run).toMatchObject({ kind: 'import', runStatus: 1, institutionId: first });
      expect(run.result).toMatchObject({ totalRows: null, processedRows: 0 });
    });

    it('answers a repeat with the same key the same run and queues nothing more', async () => {
      const fileId = await readyFile(csv(row('Asha Rao', '1')));
      const key = randomUUID();
      const a = await post('/v1/imports', owner.token, startBody(fileId), key);
      const b = await post('/v1/imports', owner.token, startBody(fileId), key);
      expect(b.status).toBe(202);
      expect(b.body.data).toEqual(a.body.data);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(await readJobs(ownerDb, societyId, 'students.import')).toHaveLength(1);
    });

    it('refuses the same key for another request: 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = randomUUID();
      await post('/v1/imports', owner.token, startBody(await readyFile(csv(row('A B', '1')))), key);
      const other = await readyFile(csv(row('C D', '2')));
      const res = await post('/v1/imports', owner.token, startBody(other), key);
      expect([res.status, res.body.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    });

    it('needs an Idempotency-Key: 400', async () => {
      const fileId = await readyFile(csv(row('A B', '1')));
      const res = await post('/v1/imports', owner.token, startBody(fileId), null);
      expect([res.status, res.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    });

    it('allows one run at a time for an Institution: 409 IMPORT_ALREADY_RUNNING, until it has finished', async () => {
      const one = await readyFile(csv(row('A B', '1')));
      const two = await readyFile(csv(row('C D', '2')));
      expect((await start(one)).status).toBe(202);
      const refused = await start(two);
      expect([refused.status, refused.body.code]).toEqual([409, 'IMPORT_ALREADY_RUNNING']);
      await runner.runNext();
      expect((await start(two)).status).toBe(202);
    });

    it('refuses a second import while the first is still running, not only while it is queued', async () => {
      const rows = Array.from({ length: 150 }, (_v, i) => row(`Pupil ${i + 1}`, String(i + 1)));
      const running = await start(await readyFile(csv(...rows)));
      const jobs = t.app.get(JobsRepository);
      // The worker saves one batch and loses its lease, which leaves the run Running.
      vi.spyOn(jobs, 'extend').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await runner.runNext();
      vi.restoreAllMocks();
      expect((await status(running.body.data.importId as string)).runStatus).toBe(2);

      const refused = await start(await readyFile(csv(row('C D', '200'))));
      expect([refused.status, refused.body.code]).toEqual([409, 'IMPORT_ALREADY_RUNNING']);
    });

    it('lets two Institutions import at once', async () => {
      const one = await readyFile(csv(row('A B', '1')));
      const other = await readyFile(csv(row('C D', '2')), { institutionId: second });
      expect((await start(one)).status).toBe(202);
      const res = await post(
        '/v1/imports',
        owner.token,
        startBody(other, { institutionId: second, academicYearId: placeAtSecond.academicYearId }),
      );
      expect(res.status).toBe(202);
    });

    it('refuses a file that is not confirmed: 422 FILE_NOT_READY', async () => {
      const given = await ticket(csv(row('A B', '1')));
      const res = await start(given.fileId);
      expect([res.status, res.body.code]).toEqual([422, 'FILE_NOT_READY']);
    });

    it('refuses a file of another purpose or another uploader with 400 on fileId, and a file of another Institution as not found', async () => {
      const csvBytes = csv(row('A B', '1'));
      const photoBytes = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.alloc(40, 1),
      ]);
      const photo = await ticket(photoBytes, { purpose: 3, contentType: 'image/jpeg' });
      await send(photo, photoBytes, 'image/jpeg');
      await api('post', `/v1/files/${photo.fileId}/confirm`, owner.token);
      const ownersFile = await readyFile(csvBytes);
      for (const [fileId, token] of [
        [photo.fileId, owner.token],
        [ownersFile, institutionAdmin.token],
      ] as const) {
        const res = await start(fileId, {}, token);
        expect([res.status, res.body.errors?.[0]]).toEqual([
          400,
          expect.objectContaining({ field: 'fileId', code: 'INVALID_VALUE' }),
        ]);
      }
      // The request acts in one Institution, which cannot see a file of the Society's other one.
      const elsewhere = await readyFile(csvBytes, { institutionId: second });
      expect((await start(elsewhere)).status).toBe(404);
    });

    it('answers 404 for a file that does not exist and for a year of another Institution', async () => {
      const fileId = await readyFile(csv(row('A B', '1')));
      expect((await start(randomUUID())).status).toBe(404);
      expect((await start(fileId, { academicYearId: placeAtSecond.academicYearId })).status).toBe(
        404,
      );
    });

    it('refuses a year that is closed: 422 YEAR_NOT_ACTIVE', async () => {
      const year = await kit.year(owner.token, first, {
        name: '2024-2025',
        startDate: '2024-06-01',
        endDate: '2025-03-31',
      });
      const closed = await api('delete', `/v1/academic-years/${year}`, owner.token);
      expect(closed.status).toBe(200);
      const fileId = await readyFile(csv(row('A B', '1')));
      const res = await start(fileId, { academicYearId: year });
      expect([res.status, res.body.code]).toEqual([422, 'YEAR_NOT_ACTIVE']);
    });

    it('refuses an Institution the caller does not reach with 404, and a Teacher with 403', async () => {
      const fileId = await readyFile(csv(row('A B', '1')));
      const asAdmin = await post(
        '/v1/imports',
        institutionAdmin.token,
        startBody(fileId, { institutionId: second }),
      );
      expect(asAdmin.status).toBe(404);
      const staff = await kit.staff(owner.token, first, categoryId);
      const teacher = await kit.actingAs(staff.person.email, TEACHER, societyId, '10.0.0.8');
      expect((await start(fileId, {}, teacher)).status).toBe(403);
    });

    it('refuses what the body gets wrong: 400', async () => {
      const fileId = await readyFile(csv(row('A B', '1')));
      for (const fields of [
        { importType: 2 },
        { importType: '1' },
        { fileId: 'x' },
        { academicYearId: undefined },
      ]) {
        expect((await start(fileId, fields)).status).toBe(400);
      }
    });
  });

  describe('the worker', () => {
    it('adds the students of the file, skips the rows that break a rule with their reasons, and says how many', async () => {
      const run = await importFile(
        csv(
          row('Asha Devi Rao', '1', 'Meera@Parent.test'),
          row('Kabir', '2'),
          row('', '3'),
          row('Zoya Khan', '4', '', '9th grade'),
          row('Ira Nair', '5', '', '9th', 'Z'),
          row('Dev Shah', '1'),
          row('Neel Rao', '6', 'not-an-email'),
          row('Tia Rao', '7', 'Meera@parent.test', ' 9TH ', ' a '),
        ),
      );
      expect(run.runStatus).toBe(3);
      expect(run.startedAt).not.toBeNull();
      expect(run.finishedAt).not.toBeNull();
      expect(run.error).toBeNull();
      expect(run.result).toMatchObject({
        totalRows: 8,
        processedRows: 8,
        importedRows: 3,
        skippedRows: 5,
        overCapacity: false,
        summary: '3 students imported, 5 row(s) skipped',
      });
      expect(run.result.rowErrors).toEqual([
        { row: 4, message: 'Name is required' },
        { row: 5, message: "'9th grade' is not a recognized class" },
        { row: 6, message: "'Z' is not a recognized section of class '9th'" },
        { row: 7, message: 'RollNumber is already used in this section' },
        { row: 8, message: 'GuardianEmail is not a valid email address' },
      ]);
      const found = await students();
      expect(found.map((s) => s.firstName).toSorted()).toEqual(['Asha Devi', 'Kabir', 'Tia']);
    });

    it('imports a file that starts with a byte order mark, as Excel saves "CSV UTF-8"', async () => {
      const bytes = Buffer.concat([Buffer.from('\ufeff'), csv(row('Asha Rao', '1'))]);
      const run = await importFile(bytes);
      expect(run).toMatchObject({ runStatus: 3, result: { importedRows: 1, skippedRows: 0 } });
      expect(await studentCount()).toBe(1);
    });

    it('makes each student as STU-02 does: placed, one primary guardian of relation 3 with phone code 91, no mobile of their own', async () => {
      await importFile(csv(row('Asha Devi Rao', '1', 'meera@parent.test')));
      const [listed] = await students();
      const student = await profile(listed!.id);
      expect(student).toMatchObject({
        firstName: 'Asha Devi',
        lastName: 'Rao',
        mobile: null,
        placement: { ...place, rollNumber: '1' },
      });
      expect(student.guardians).toEqual([
        expect.objectContaining({
          firstName: 'Meera',
          lastName: 'Rao',
          relation: 3,
          isPrimary: true,
          hasLogin: true,
          email: 'meera@parent.test',
          phone: { countryCode: '91', number: '9876500001' },
        }),
      ]);
    });

    it('stamps the students and the audit with the person who started the import, not with nobody', async () => {
      const run = await importFile(csv(row('Asha Rao', '1')), institutionAdmin.token);
      const [listed] = await students();
      const rows = await readAuditRows<{
        actor_user_id: string | null;
        actor_role_code: number | null;
      }>(ownerDb, sql`entity_id in (${listed!.id}, ${run.id})`);
      expect(rows.map((r) => [r.actor_user_id, r.actor_role_code])).toEqual(
        expect.arrayContaining([[institutionAdmin.person, 3]]),
      );
      expect(rows.every((r) => r.actor_user_id === institutionAdmin.person)).toBe(true);
      expect(await audit(run.id)).toEqual(
        expect.arrayContaining([
          {
            action: 'import.finished',
            institutionId: first,
            after: { importedRows: 1, skippedRows: 0 },
          },
        ]),
      );
    });

    it('sends each new parent login its welcome mail, once for each login, after the batch commits', async () => {
      await importFile(
        csv(
          row('Asha Rao', '1', 'one@parent.test'),
          row('Kabir Rao', '2', 'one@parent.test'),
          row('Ira Rao', '3', 'two@parent.test'),
        ),
      );
      expect(t.email.count('one@parent.test')).toBeGreaterThanOrEqual(1);
      expect(t.email.count('two@parent.test')).toBe(1);
      const one = (await students()).length;
      expect(one).toBe(3);
    });

    it('links a guardian email that belongs to a parent already, so siblings share one login', async () => {
      const sibling = await kit.student(owner.token, first, place, {
        guardians: [
          {
            firstName: 'Ravi',
            relation: 1,
            phone: { countryCode: '91', number: '9845012345' },
            email: 'shared@parent.test',
            isPrimary: true,
            isEmergencyContact: true,
          },
        ],
      });
      await importFile(csv(row('Asha Rao', '1', 'shared@parent.test')));
      const imported = (await students()).find((s) => s.id !== sibling.id)!;
      const guardian = (await profile(imported.id)).guardians[0]!;
      expect(guardian.email).toBe('shared@parent.test');
      const people = await sql<{ n: number }>`
        select count(*)::int as n from users where email = 'shared@parent.test'`.execute(ownerDb);
      expect(people.rows[0]!.n).toBe(1);
    });

    it('skips a row whose guardian email belongs to a Super Admin and says why, without the email', async () => {
      const run = await importFile(csv(row('Asha Rao', '1', superAdmin.email)));
      expect(run.result).toMatchObject({ importedRows: 0, skippedRows: 1 });
      expect(run.result.rowErrors).toEqual([
        { row: 2, message: 'GuardianEmail belongs to an account that cannot also be a parent' },
      ]);
      expect(JSON.stringify(run.result.rowErrors)).not.toContain(superAdmin.email);
      expect(await students()).toEqual([]);
    });

    it('warns when a section ends over its capacity, and still adds the students', async () => {
      const small = await api('post', '/v1/sections', owner.token, {
        classId: place.classId,
        predefinedSectionId: predefinedSectionB,
        capacity: 1,
      });
      succeeded(small, 201, 'small section');
      const run = await importFile(
        csv(row('Asha Rao', '1', '', '9th', 'B'), row('Kabir Rao', '2', '', '9th', 'B')),
      );
      expect(run.result).toMatchObject({ importedRows: 2, overCapacity: true });
    });

    it('skips rows with the wrong number of columns and rows of only commas and spaces', async () => {
      const run = await importFile(
        Buffer.from(
          [HEADER, 'Asha Rao,1,9th,A', '', ' , , , , , , ', row('Kabir Rao', '2')].join('\r\n'),
        ),
      );
      expect(run.result).toMatchObject({ totalRows: 2, importedRows: 1, skippedRows: 1 });
      expect(run.result.rowErrors).toEqual([{ row: 2, message: 'Expected 7 columns but found 4' }]);
    });

    it('completes a file with a header only, with nothing imported', async () => {
      const run = await importFile(csv());
      expect(run).toMatchObject({ runStatus: 3 });
      expect(run.result).toMatchObject({
        totalRows: 0,
        importedRows: 0,
        summary: '0 students imported, 0 row(s) skipped',
      });
    });

    it('fails the whole run for a wrong header, with no student added: CSV_HEADER_INVALID', async () => {
      const run = await importFile(Buffer.from(['Name,Class,Roll', 'Asha Rao,9th,1'].join('\r\n')));
      expect(run.runStatus).toBe(4);
      expect(run.error).toEqual({
        code: 'CSV_HEADER_INVALID',
        message: expect.stringContaining('Name,RollNumber,Class') as string,
      });
      expect(run.result).toMatchObject({ importedRows: 0, skippedRows: 0 });
      expect(await students()).toEqual([]);
    });

    it('fails the whole run for more than 5,000 rows: CSV_TOO_LARGE', async () => {
      const rows = Array.from({ length: 5_001 }, (_v, i) => `S ${i},${i},9th,A,G,9876543210,`);
      const run = await importFile(Buffer.from([HEADER, ...rows].join('\n')));
      expect([run.runStatus, run.error?.code]).toEqual([4, 'CSV_TOO_LARGE']);
      expect(await students()).toEqual([]);
    });

    it('settles the job of a finished run as done, and a finished run is not run twice', async () => {
      await importFile(csv(row('Asha Rao', '1')));
      const [job] = await readJobs(ownerDb, societyId, 'students.import');
      expect(job).toMatchObject({ job_status: 3, last_error: null });
      expect(job!.finished_at).not.toBeNull();
      expect(await runner.runNext()).toBe(false);
    });

    it('saves 100 rows to a transaction and resumes after the last committed batch when the worker dies', async () => {
      const rows = Array.from({ length: 250 }, (_v, i) => row(`Pupil ${i + 1}`, String(i + 1)));
      const res = await start(await readyFile(csv(...rows)));
      const id = res.body.data.importId as string;
      // The lease is lost after the first batch: the worker stops where a dead one would.
      const jobs = t.app.get(JobsRepository);
      const extend = vi
        .spyOn(jobs, 'extend')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      expect(await runner.runNext()).toBe(true);
      extend.mockRestore();
      expect(await progress(id)).toMatchObject({ run_status: 2, processed_rows: 100 });
      expect(await studentCount()).toBe(100);
      expect(await runner.runNext()).toBe(false);
      // Its lease runs out; the next worker takes the job over and finishes the file.
      await changeJobs(ownerDb, societyId, sql`locked_until = now() - interval '1 second'`);
      expect(await runner.runNext()).toBe(true);
      const run = await status(id);
      expect(run.runStatus).toBe(3);
      expect(run.result).toMatchObject({
        totalRows: 250,
        processedRows: 250,
        importedRows: 250,
        skippedRows: 0,
      });
      expect(await studentCount()).toBe(250);
      const [job] = await readJobs(ownerDb, societyId, 'students.import');
      expect(job).toMatchObject({ job_status: 3, attempts: 2 });
    });

    it('keeps at most 1,000 row errors and counts every skipped row', async () => {
      const rows = Array.from({ length: 1_050 }, (_v, i) => row('', String(i + 1)));
      const run = await importFile(csv(...rows));
      expect(run.result.skippedRows).toBe(1_050);
      expect(run.result.rowErrors).toHaveLength(1_000);
      expect(run.result.rowErrors[999]).toEqual({ row: 1_001, message: 'Name is required' });
    });

    it('queues the job again after a fault that is not the row’s, saves nothing of that batch, and finishes on the next try', async () => {
      const students$ = t.app.get(StudentService);
      const add = vi
        .spyOn(students$, 'addWithin')
        .mockRejectedValueOnce(new Error('connection lost'));
      const res = await start(await readyFile(csv(row('Asha Rao', '1'), row('Kabir Rao', '2'))));
      const id = res.body.data.importId as string;
      expect(await runner.runNext()).toBe(true);
      expect(await students()).toEqual([]);
      expect(await progress(id)).toMatchObject({ run_status: 2, processed_rows: 0 });
      const [queued] = await readJobs(ownerDb, societyId, 'students.import');
      expect(queued).toMatchObject({ job_status: 1, attempts: 1, last_error: 'Error' });
      expect(queued!.run_at.getTime()).toBeGreaterThan(Date.now());
      expect(await runner.runNext()).toBe(false);
      await changeJobs(ownerDb, societyId, sql`run_at = now()`);
      add.mockRestore();
      expect(await runner.runNext()).toBe(true);
      expect((await status(id)).result).toMatchObject({ importedRows: 2, skippedRows: 0 });
    });

    it('fails the run and the job when the last attempt fails, so the Institution can import again', async () => {
      const students$ = t.app.get(StudentService);
      vi.spyOn(students$, 'addWithin').mockRejectedValue(new Error('connection lost'));
      const res = await start(await readyFile(csv(row('Asha Rao', '1'))));
      const id = res.body.data.importId as string;
      await changeJobs(ownerDb, societyId, sql`attempts = ${MAX_ATTEMPTS - 1}`);
      expect(await runner.runNext()).toBe(true);
      const run = await status(id);
      expect(run.runStatus).toBe(4);
      expect(run.error).toEqual({ code: 'IMPORT_FAILED', message: expect.any(String) as string });
      const [job] = await readJobs(ownerDb, societyId, 'students.import');
      expect(job).toMatchObject({ job_status: 4, last_error: 'Error' });
      vi.restoreAllMocks();
      expect((await start(await readyFile(csv(row('Asha Rao', '1'))))).status).toBe(202);
    });

    it('does not let a worker that lost its lease save a batch behind the one that has the job', async () => {
      const rows = Array.from({ length: 150 }, (_v, i) => row(`Pupil ${i + 1}`, String(i + 1)));
      const res = await start(await readyFile(csv(...rows)));
      const id = res.body.data.importId as string;
      const jobs = t.app.get(JobsRepository);
      vi.spyOn(jobs, 'extend').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await runner.runNext();
      vi.restoreAllMocks();
      expect(await progress(id)).toMatchObject({ processed_rows: 100 });
      expect(await studentCount()).toBe(100);
    });
  });

  describe('IMP-03 status and IMP-04 recent imports', () => {
    it('reads the run for the Owner and for an Institution Admin of the Institution, and 404 for the rest', async () => {
      const run = await importFile(csv(row('Asha Rao', '1')));
      expect((await status(run.id, institutionAdmin.token)).id).toBe(run.id);
      const otherAdmin = await fixtures.institutionAdmin(societyId, [second]);
      expect((await api('get', `/v1/imports/${run.id}`, otherAdmin.token)).status).toBe(404);
      expect((await api('get', `/v1/imports/${randomUUID()}`, owner.token)).status).toBe(404);
      const staff = await kit.staff(owner.token, first, categoryId);
      const teacher = await kit.actingAs(staff.person.email, TEACHER, societyId, '10.0.0.9');
      expect((await api('get', `/v1/imports/${run.id}`, teacher)).status).toBe(403);
      const elsewhere = await kit.society(admin);
      const stranger = await fixtures.owner(elsewhere);
      expect((await api('get', `/v1/imports/${run.id}`, stranger.token)).status).toBe(404);
    });

    it('lists the recent runs of an Institution, newest first, a page at a time', async () => {
      const one = await importFile(csv(row('Asha Rao', '1')));
      const two = await importFile(csv(row('Kabir Rao', '2')));
      const res = await api('get', `/v1/imports?institutionId=${first}&limit=1`, owner.token);
      expect(res.status).toBe(200);
      expect((res.body.data as unknown as RunBody[]).map((r) => r.id)).toEqual([two.id]);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 1, totalItems: 2, totalPages: 2 });
      const next = await api(
        'get',
        `/v1/imports?institutionId=${first}&limit=1&page=2`,
        owner.token,
      );
      expect((next.body.data as unknown as RunBody[]).map((r) => r.id)).toEqual([one.id]);
    });

    it('lists only the Institution asked for, and answers 404 for one the caller does not reach', async () => {
      await importFile(csv(row('Asha Rao', '1')));
      const none = await api('get', `/v1/imports?institutionId=${second}`, owner.token);
      expect(none.body.data).toEqual([]);
      const refused = await api(
        'get',
        `/v1/imports?institutionId=${second}`,
        institutionAdmin.token,
      );
      expect(refused.status).toBe(404);
      expect((await api('get', '/v1/imports', owner.token)).status).toBe(400);
    });
  });

  describe('the jobs table', () => {
    it('lets the app role queue and read the jobs of its own Institution, and change none', async () => {
      const tenant = { personId: owner.person, roleCode: 2, societyId, institutionIds: [first] };
      await sql`insert into jobs (society_id, institution_id, kind) values (${societyId}, ${second}, 'test.other')`.execute(
        ownerDb,
      );
      await database.transaction(tenant, async (tx) => {
        await sql`insert into jobs (society_id, institution_id, kind) values (${societyId}, ${first}, 'test.kind')`.execute(
          tx,
        );
        const seen = await sql<{
          kind: string;
        }>`select kind from jobs where kind like 'test.%'`.execute(tx);
        expect(seen.rows).toEqual([{ kind: 'test.kind' }]);
      });
      expect(await readJobs(ownerDb, societyId, 'test.kind')).toHaveLength(1);
      for (const change of [sql`update jobs set job_status = 3`, sql`delete from jobs`]) {
        await expect(database.transaction(tenant, (tx) => change.execute(tx))).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it('lets only the worker that holds the claim extend, settle or requeue a job, once another has taken it over', async () => {
      const queue = t.app.get(JobsRepository);
      await sql`insert into jobs (society_id, institution_id, kind) values (${societyId}, ${first}, 'test.fence')`.execute(
        ownerDb,
      );
      const a = await queue.claim(60);
      expect(a).toMatchObject({ kind: 'test.fence', attempts: 1 });
      // A's lease runs out and B takes the job over.
      await changeJobs(ownerDb, societyId, sql`locked_until = now() - interval '1 second'`);
      const b = await queue.claim(60);
      expect([b?.id, b?.attempts]).toEqual([a!.id, 2]);
      // A is told it lost the job, and changes nothing of it.
      expect(await queue.extend(a!.id, 1, 60)).toBe(false);
      expect(await queue.retry(a!.id, 1, 30, 'Error')).toBe(false);
      expect(await queue.settle(a!.id, 1, true, null)).toBe(false);
      expect(await readJobs(ownerDb, societyId, 'test.fence')).toMatchObject([
        { job_status: 2, attempts: 2, last_error: null },
      ]);
      // B still holds it: it can extend, and then end it.
      expect(await queue.extend(a!.id, 2, 60)).toBe(true);
      expect(await queue.settle(a!.id, 2, true, null)).toBe(true);
      expect(await readJobs(ownerDb, societyId, 'test.fence')).toMatchObject([{ job_status: 3 }]);
      // Nothing of a settled job can be changed again.
      expect(await queue.retry(a!.id, 2, 30, 'Error')).toBe(false);
    });

    it('refuses a job for another Society or another Institution of the caller’s Society', async () => {
      const tenant = { personId: owner.person, roleCode: 2, societyId, institutionIds: [first] };
      await expect(
        database.transaction(tenant, (tx) =>
          sql`insert into jobs (society_id, institution_id, kind) values (${societyId}, ${second}, 'x')`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        database.transaction(tenant, (tx) =>
          sql`insert into jobs (society_id, kind) values (${randomUUID()}, 'x')`.execute(tx),
        ),
      ).rejects.toThrow();
    });
  });
});
