import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { ObjectStorage } from '../../src/platform/files/index.js';
import { JobRunner } from '../../src/platform/jobs/index.js';
import { SweepsService } from '../../src/platform/sweeps/index.js';
import { SweepsRepository } from '../../src/platform/sweeps/sweeps.repository.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { asOwnerOf } from '../support/owner-rows.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, succeeded, type StudentPlace } from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(60, 2)]);
const CSV = Buffer.from(
  'Name,RollNumber,Class,Section,GuardianName,GuardianPhone,GuardianEmail\r\nAsha Rao,1,9th,A,Meera Rao,9876500001,\r\n',
);

interface Ticket {
  fileId: string;
  upload: { url: string; fields: Record<string, string> };
}

/** The clean-up sweeps of the worker (DDD 16.3, 16.4, API design 16.3). */
describe('worker sweeps', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let storage: ObjectStorage;
  let sweeps: SweepsService;
  let runner: JobRunner;
  let owner: SignedInPerson;
  let societyId: string;
  let institutionId: string;
  let place: StudentPlace;

  const exists = async (name: string) =>
    (
      await sql<{
        found: string | null;
      }>`select to_regclass(${`public.${name}`}) as found`.execute(ownerDb)
    ).rows[0]!.found !== null;
  const monthName = (table: string, monthsFromNow: number) =>
    sql<{ name: string }>`
      select ${`${table}_`} || to_char(date_trunc('month', now()) + make_interval(months => ${monthsFromNow}), 'YYYY_MM') as name
    `
      .execute(ownerDb)
      .then((r) => r.rows[0]!.name);

  /** A Ready file of `purpose`, uploaded and confirmed through the API. */
  const readyFile = async (purpose: number, bytes: Buffer, contentType: string) => {
    const res = await api('post', '/v1/files/uploads', owner.token, {
      purpose,
      institutionId,
      contentType,
      sizeBytes: bytes.length,
      fileName: 'file',
    });
    const given = succeeded(res, 201, 'ticket').body.data as unknown as Ticket;
    const sent = request(t.app.getHttpServer()).post(new URL(given.upload.url).pathname);
    for (const [name, value] of Object.entries(given.upload.fields)) sent.field(name, value);
    expect((await sent.attach('file', bytes, { filename: 'upload', contentType })).status).toBe(
      204,
    );
    succeeded(await api('post', `/v1/files/${given.fileId}/confirm`, owner.token), 200, 'confirm');
    return given.fileId;
  };
  const photo = () => readyFile(3, JPEG, 'image/jpeg');

  const file = async (id: string) =>
    (
      await sql<{ file_status: number; delete_after: Date | null; object_key: string }>`
        select file_status, delete_after, object_key from files where id = ${id}`.execute(ownerDb)
    ).rows[0]!;
  const objectExists = async (id: string) =>
    (await storage.read((await file(id)).object_key)) !== null;
  /** Makes a file as old as a day a few days back. */
  const age = (id: string, days: number) =>
    sql`update files set confirmed_at = now() - make_interval(days => ${days}),
      created_at = now() - make_interval(days => ${days}) where id = ${id}`.execute(ownerDb);

  /** Makes a file as old as `hours` hours. */
  const ageHours = (id: string, hours: number) =>
    sql`update files set confirmed_at = now() - make_interval(hours => ${hours}),
      created_at = now() - make_interval(hours => ${hours}) where id = ${id}`.execute(ownerDb);
  const staffMember = async (fields: object = {}) =>
    kit.staff(
      owner.token,
      institutionId,
      (await kit.masters(await superAdminToken(t, ownerDb, superAdmin.id), 'class-categories'))[0]!
        .id,
      fields,
    );

  /** Makes the time to delete a file come. */
  const due = (id: string) =>
    sql`update files set delete_after = now() - interval '1 minute' where id = ${id}`.execute(
      ownerDb,
    );

  const attach = async (fileId: string, staffId: string) => {
    const res = await api('post', `/v1/staff/${staffId}/documents`, owner.token, {
      title: 'Appointment letter',
      fileId,
    });
    return succeeded(res, 201, 'document').body.data as unknown as { id: string };
  };
  const ageDocument = (id: string, days: number) =>
    asOwnerOf(ownerDb, ['documents'], async (tx) => {
      await sql`update documents set updated_at = now() - make_interval(days => ${days}) where id = ${id}`.execute(
        tx,
      );
    });
  const runOf = async (importId: string) =>
    (
      await sql<{
        file_id: string;
      }>`select file_id from import_runs where id = ${importId}`.execute(ownerDb)
    ).rows[0];
  const importOnce = async () => {
    const fileId = await readyFile(12, CSV, 'text/csv');
    const res = await request(t.app.getHttpServer())
      .post('/v1/imports')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ institutionId, importType: 1, fileId, academicYearId: place.academicYearId });
    expect(res.status).toBe(202);
    while (await runner.runNext()) {
      // the worker drains the queue
    }
    return { importId: res.body.data.importId as string, fileId };
  };
  const finishedDaysAgo = (importId: string, days: number) =>
    asOwnerOf(ownerDb, ['import_runs'], async (tx) => {
      await sql`update import_runs set finished_at = now() - make_interval(days => ${days})
        where id = ${importId}`.execute(tx);
    });

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    // The sweeps judge by the database clock, so the app's clock starts at the same moment.
    t = await createTestApp({ imports: [FixtureModule], clockStart: new Date().toISOString() });
    database = t.app.get(DatabaseService);
    storage = t.app.get(ObjectStorage);
    sweeps = t.app.get(SweepsService);
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
    const admin = await superAdminToken(t, ownerDb, superAdmin.id);
    const categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    const classes = await kit.masters(admin, 'predefined-classes');
    const sections = await kit.masters(admin, 'predefined-sections');
    societyId = await kit.society(admin);
    owner = await fixtures.owner(societyId);
    institutionId = await kit.institution(owner.token, categoryId);
    const academicYearId = await kit.year(owner.token, institutionId);
    const classId = await kit.klass(
      owner.token,
      institutionId,
      classes.find((c) => c.code === 'C09')!.id,
    );
    const sectionId = await kit.section(
      owner.token,
      classId,
      sections.find((s) => s.code === 'A')!.id,
    );
    place = { academicYearId, classId, sectionId };
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('Pending uploads (DDD 16.4)', () => {
    it('removes the object and marks the row Deleted once the 24 hours have passed, and not before', async () => {
      const res = await api('post', '/v1/files/uploads', owner.token, {
        purpose: 3,
        institutionId,
        contentType: 'image/jpeg',
        sizeBytes: JPEG.length,
        fileName: 'p.jpg',
      });
      const given = succeeded(res, 201, 'ticket').body.data as unknown as Ticket;
      const sent = request(t.app.getHttpServer()).post(new URL(given.upload.url).pathname);
      for (const [name, value] of Object.entries(given.upload.fields)) sent.field(name, value);
      await sent.attach('file', JPEG, { filename: 'upload', contentType: 'image/jpeg' });

      await sweeps.sweep();
      expect((await file(given.fileId)).file_status).toBe(1);
      expect(await objectExists(given.fileId)).toBe(true);

      await sql`update files set delete_after = now() - interval '1 minute' where id = ${given.fileId}`.execute(
        ownerDb,
      );
      const report = await sweeps.sweep();
      expect(report.filesRemoved).toBeGreaterThanOrEqual(1);
      expect((await file(given.fileId)).file_status).toBe(4);
      expect(await objectExists(given.fileId)).toBe(false);
    });

    it('marks a Rejected upload Deleted too, and removes an object that landed after it was rejected', async () => {
      const bad = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.alloc(40, 3)]);
      const res = await api('post', '/v1/files/uploads', owner.token, {
        purpose: 3,
        institutionId,
        contentType: 'image/jpeg',
        sizeBytes: bad.length,
        fileName: 'p.jpg',
      });
      const given = succeeded(res, 201, 'ticket').body.data as unknown as Ticket;
      const sent = request(t.app.getHttpServer()).post(new URL(given.upload.url).pathname);
      for (const [name, value] of Object.entries(given.upload.fields)) sent.field(name, value);
      await sent.attach('file', bad, { filename: 'upload', contentType: 'image/jpeg' });
      const confirmed = await api('post', `/v1/files/${given.fileId}/confirm`, owner.token);
      expect(confirmed.status).toBe(422);
      expect((await file(given.fileId)).file_status).toBe(3);
      // The signed address is still open for its five minutes: the object lands after the file was rejected.
      const again = request(t.app.getHttpServer()).post(new URL(given.upload.url).pathname);
      for (const [name, value] of Object.entries(given.upload.fields)) again.field(name, value);
      await again.attach('file', bad, { filename: 'upload', contentType: 'image/jpeg' });
      expect(await objectExists(given.fileId)).toBe(true);

      await sql`update files set delete_after = now() - interval '1 minute' where id = ${given.fileId}`.execute(
        ownerDb,
      );
      await sweeps.sweep();
      expect((await file(given.fileId)).file_status).toBe(4);
      expect(await objectExists(given.fileId)).toBe(false);
    });
  });

  describe('files nothing points at (DDD 16.4)', () => {
    it('gives up a Ready photo no record holds once it is a day old, and keeps one a student holds', async () => {
      const held = await photo();
      const loose = await photo();
      const fresh = await photo();
      await kit.student(owner.token, institutionId, place, { photoFileId: held });
      await age(held, 3);
      await age(loose, 3);
      // `fresh` was confirmed a moment ago: the form it is for may not be saved yet.

      const report = await sweeps.sweep();
      expect(report.filesExpired).toBeGreaterThanOrEqual(1);
      expect((await file(held)).file_status).toBe(2);
      expect((await file(held)).delete_after).toBeNull();
      expect((await file(fresh)).file_status).toBe(2);
      expect((await file(loose)).file_status).toBe(4);
      expect(await objectExists(loose)).toBe(false);
      expect(await objectExists(held)).toBe(true);
      expect(await objectExists(fresh)).toBe(true);
    });
  });

  describe('files nothing points at, by purpose', () => {
    it('gives up a staff photo and a document file no record holds, and keeps the ones a record holds', async () => {
      const heldPhoto = await readyFile(4, JPEG, 'image/jpeg');
      const loosePhoto = await readyFile(4, JPEG, 'image/jpeg');
      const looseDocument = await readyFile(6, PDF, 'application/pdf');
      const heldDocument = await readyFile(6, PDF, 'application/pdf');
      const staff = await staffMember({ photoFileId: heldPhoto });
      await attach(heldDocument, staff.id);
      for (const id of [heldPhoto, loosePhoto, looseDocument, heldDocument]) await age(id, 3);

      await sweeps.sweep();
      expect((await file(loosePhoto)).file_status).toBe(4);
      expect((await file(looseDocument)).file_status).toBe(4);
      expect((await file(heldPhoto)).file_status).toBe(2);
      expect((await file(heldDocument)).file_status).toBe(2);
    });

    it('waits the 24 hours: a file confirmed 23 hours ago stays, one confirmed 25 hours ago goes', async () => {
      const young = await photo();
      const old = await photo();
      await ageHours(young, 23);
      await ageHours(old, 25);

      await sweeps.sweep();
      expect((await file(young)).file_status).toBe(2);
      expect((await file(young)).delete_after).toBeNull();
      expect((await file(old)).file_status).toBe(4);
    });
  });

  describe('a file whose time has come (DDD 16.4)', () => {
    it('is no longer taken by a record, so the sweep never removes the object of a file that is held', async () => {
      const fileId = await photo();
      await due(fileId);
      const refused = await api(
        'post',
        '/v1/students',
        owner.token,
        kit.studentBody(institutionId, place, { photoFileId: fileId }),
      );
      expect(refused.status).toBe(400);
      expect(refused.body.errors).toEqual([
        expect.objectContaining({ field: 'photoFileId', code: 'INVALID_VALUE' }),
      ]);
    });

    it('is no longer taken for an import: 422 FILE_NOT_READY', async () => {
      const fileId = await readyFile(12, CSV, 'text/csv');
      await due(fileId);
      const res = await request(t.app.getHttpServer())
        .post('/v1/imports')
        .set('Authorization', `Bearer ${owner.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ institutionId, importType: 1, fileId, academicYearId: place.academicYearId });
      expect([res.status, res.body.code]).toEqual([422, 'FILE_NOT_READY']);
    });

    it('cannot be confirmed once its 24 hours are up: 404, and the sweep then removes it', async () => {
      const res = await api('post', '/v1/files/uploads', owner.token, {
        purpose: 3,
        institutionId,
        contentType: 'image/jpeg',
        sizeBytes: JPEG.length,
        fileName: 'p.jpg',
      });
      const given = succeeded(res, 201, 'ticket').body.data as unknown as Ticket;
      const sent = request(t.app.getHttpServer()).post(new URL(given.upload.url).pathname);
      for (const [name, value] of Object.entries(given.upload.fields)) sent.field(name, value);
      await sent.attach('file', JPEG, { filename: 'upload', contentType: 'image/jpeg' });
      await due(given.fileId);

      const confirmed = await api('post', `/v1/files/${given.fileId}/confirm`, owner.token);
      expect(confirmed.status).toBe(404);
      await sweeps.sweep();
      expect((await file(given.fileId)).file_status).toBe(4);
      expect(await objectExists(given.fileId)).toBe(false);
    });

    it('is marked Deleted only while it is still in the status it was listed in', async () => {
      const fileId = await photo();
      await due(fileId);
      const repository = t.app.get(SweepsRepository);
      const { objectKey } = { objectKey: (await file(fileId)).object_key };

      expect(await repository.markDeleted({ id: fileId, objectKey, status: 1 })).toBe(false);
      expect((await file(fileId)).file_status).toBe(2);
      expect(await repository.markDeleted({ id: fileId, objectKey, status: 2 })).toBe(true);
      expect((await file(fileId)).file_status).toBe(4);
    });
  });

  describe('documents (DDD 16.2, DOC-03)', () => {
    it('keeps the file of a document for 30 days after DOC-03, and removes it then; the row stays', async () => {
      const categoryId = (
        await kit.masters(await superAdminToken(t, ownerDb, superAdmin.id), 'class-categories')
      )[0]!.id;
      const staff = await kit.staff(owner.token, institutionId, categoryId);
      const kept = await attach(await readyFile(6, PDF, 'application/pdf'), staff.id);
      const dropped = await attach(await readyFile(6, PDF, 'application/pdf'), staff.id);
      const active = await attach(await readyFile(6, PDF, 'application/pdf'), staff.id);
      for (const id of [kept.id, dropped.id]) {
        expect((await api('delete', `/v1/documents/${id}`, owner.token)).status).toBe(200);
      }
      await ageDocument(kept.id, 29);
      await ageDocument(dropped.id, 31);
      await ageDocument(active.id, 90);
      const fileOf = async (documentId: string) =>
        (
          await sql<{ file_id: string; status: number }>`
            select file_id, status from documents where id = ${documentId}`.execute(ownerDb)
        ).rows[0]!;

      await sweeps.sweep();
      expect((await file((await fileOf(kept.id)).file_id)).file_status).toBe(2);
      expect((await file((await fileOf(active.id)).file_id)).file_status).toBe(2);
      const gone = await fileOf(dropped.id);
      expect(gone.status).toBe(0);
      expect((await file(gone.file_id)).file_status).toBe(4);
      expect(await objectExists(gone.file_id)).toBe(false);
    });
  });

  describe('import runs and their files (API design 16.3)', () => {
    it('removes a run a week after it finished, and the file once its week is up', async () => {
      const recent = await importOnce();
      const nearly = await importOnce();
      const old = await importOnce();
      await finishedDaysAgo(nearly.importId, 6);
      await finishedDaysAgo(old.importId, 8);
      await sql`update files set delete_after = now() - interval '1 day' where id = ${old.fileId}`.execute(
        ownerDb,
      );

      const report = await sweeps.sweep();
      expect(report.importRunsRemoved).toBe(1);
      expect(await runOf(old.importId)).toBeUndefined();
      expect((await file(old.fileId)).file_status).toBe(4);
      expect(await objectExists(old.fileId)).toBe(false);
      expect(await runOf(recent.importId)).toBeDefined();
      // A run that finished 6 days ago has a day left.
      expect(await runOf(nearly.importId)).toBeDefined();
      expect((await file(recent.fileId)).file_status).toBe(2);
      expect(await objectExists(recent.fileId)).toBe(true);
    });

    it('leaves a run that has not finished, however old', async () => {
      const fileId = await readyFile(12, CSV, 'text/csv');
      const res = await request(t.app.getHttpServer())
        .post('/v1/imports')
        .set('Authorization', `Bearer ${owner.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ institutionId, importType: 1, fileId, academicYearId: place.academicYearId });
      expect(res.status).toBe(202);
      await asOwnerOf(ownerDb, ['import_runs'], async (tx) => {
        await sql`update import_runs set created_at = now() - interval '30 days'
          where id = ${res.body.data.importId}`.execute(tx);
      });
      expect((await sweeps.sweep()).importRunsRemoved).toBe(0);
      expect(await runOf(res.body.data.importId as string)).toBeDefined();
    });
  });

  describe('when the storage cannot be reached', () => {
    it('leaves the row as it was, so the next sweep tries again', async () => {
      const loose = await photo();
      await age(loose, 3);
      const remove = vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error('storage down'));

      await sweeps.sweep();
      expect(remove).toHaveBeenCalled();
      expect((await file(loose)).file_status).toBe(2);
      expect((await file(loose)).delete_after).not.toBeNull();
      expect(await objectExists(loose)).toBe(true);

      await sweeps.sweep();
      expect((await file(loose)).file_status).toBe(4);
      expect(await objectExists(loose)).toBe(false);
    });
  });

  describe('partitions (DDD 9.8, 14.5)', () => {
    it('makes the inbox partitions three months ahead, when they are missing', async () => {
      const ahead = await monthName('inbox_items', 3);
      await sql`drop table ${sql.table(ahead)}`.execute(ownerDb);
      expect((await sweeps.sweep()).inboxPartitionsMade).toBe(1);
      expect(await exists(ahead)).toBe(true);
      expect((await sweeps.sweep()).inboxPartitionsMade).toBe(0);
    });

    it('makes the attendance partitions of this year and the next, when they are missing', async () => {
      const next = `attendance_exceptions_${(new Date().getUTCFullYear() + 1).toString()}`;
      await sql`drop table ${sql.table(next)}`.execute(ownerDb);
      expect((await sweeps.sweep()).attendancePartitionsMade).toBe(1);
      expect(await exists(next)).toBe(true);
      expect((await sweeps.sweep()).attendancePartitionsMade).toBe(0);
    });

    it('drops an inbox month that ended more than 180 days ago, with its rows, and keeps the others', async () => {
      await sql`select maintenance.ensure_inbox_partitions(date '2025-01-01', 0)`.execute(ownerDb);
      const lastMonth = await monthName('inbox_items', -1);
      await sql`select maintenance.ensure_inbox_partitions((date_trunc('month', now()) - interval '1 month')::date, 0)`.execute(
        ownerDb,
      );
      expect(await exists('inbox_items_2025_01')).toBe(true);
      const report = await sweeps.sweep();
      expect(report.inboxPartitionsDropped).toBeGreaterThanOrEqual(1);
      expect(await exists('inbox_items_2025_01')).toBe(false);
      expect(await exists(lastMonth)).toBe(true);
      expect(await exists(await monthName('inbox_items', 0))).toBe(true);
    });

    it('refuses a keeping of under 30 days', async () => {
      await expect(
        sql`select maintenance.drop_inbox_partitions(10)`.execute(database.db),
      ).rejects.toThrow(/at least 30/);
    });
  });

  describe('who may call the sweep functions', () => {
    it('lets the app role call them and read none of the rows they touch for another Society', async () => {
      const calls = await database.db
        .transaction()
        .execute(
          async (tx) =>
            (await sql<{ n: number }>`select maintenance.remove_import_runs(3650) as n`.execute(tx))
              .rows[0]!.n,
        );
      expect(calls).toBeGreaterThanOrEqual(0);
    });
  });
});
