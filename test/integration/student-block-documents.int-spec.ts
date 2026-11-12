import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import {
  down,
  up,
} from '../../src/platform/database/migrations/2026_11_12_0035_people_student_block_documents.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import {
  SchoolKit,
  succeeded,
  type SchoolStaff,
  type SchoolStudent,
  type StudentPlace,
} from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(60, 2)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);

interface Ticket {
  fileId: string;
  upload: { url: string; fields: Record<string, string> };
}
interface DocumentBody {
  id: string;
  ownerType: string;
  studentId: string;
  title: string;
  file: { id: string; contentType: string; sizeBytes: number; fileName: string | null };
  createdBy: { id: string | null };
}
interface StudentBody {
  id: string;
  isBlocked: boolean;
  blockedAt: string | null;
  version: number;
  status: number;
}

/** STU-06, STU-07, DOC-01, DOC-02 and DOC-03 for students (API design 9.6, 10.5b, DDD D-02). */
describe('a student’s block and documents', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;
  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let societyId: string;
  let first: string;
  let second: string;
  let categoryId: string;
  let place: StudentPlace;
  let placeAtSecond: StudentPlace;
  let diya: SchoolStudent;
  let ravi: SchoolStudent;

  const admit = (at: StudentPlace, fields: object = {}) =>
    kit.student(owner.token, at === placeAtSecond ? second : first, at, fields);
  const block = (student: SchoolStudent, token = owner.token) =>
    api('post', `/v1/students/${student.id}/block`, token);
  const unblock = (student: SchoolStudent, token = owner.token) =>
    api('post', `/v1/students/${student.id}/unblock`, token);
  const profile = async (student: SchoolStudent, token = owner.token) =>
    (await api('get', `/v1/students/${student.id}`, token)).body.data as unknown as StudentBody;
  const documents = (student: SchoolStudent, token = owner.token) =>
    api('get', `/v1/students/${student.id}/documents`, token);
  const listed = async (student: SchoolStudent, token = owner.token) => {
    const res = await documents(student, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as DocumentBody[];
  };
  const attach = (student: SchoolStudent, body: object, token = owner.token) =>
    api('post', `/v1/students/${student.id}/documents`, token, body);
  const open = (fileId: string, token: string) => api('get', `/v1/files/${fileId}/download`, token);

  const tenant = (institutionIds: string[]) => ({
    personId: owner.person,
    roleCode: 2,
    societyId,
    institutionIds,
  });
  const read = <T>(
    work: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<T>,
    institutionIds = [first, second],
  ) => database.transaction(tenant(institutionIds), work);
  const stored = (student: SchoolStudent) =>
    read(
      async (tx) =>
        (
          await sql<{
            access_blocked_at: Date | null;
            access_blocked_by: string | null;
            version: number;
            updated_by: string;
          }>`select access_blocked_at, access_blocked_by, version, updated_by
            from students where id = ${student.id}`.execute(tx)
        ).rows[0]!,
    );
  const insert = (values: object, institutionIds = [first]) =>
    read(
      (tx) =>
        sql`insert into documents (society_id, institution_id, owner_type, student_id,
          staff_member_id, title, file_id) values (${societyId}, ${first},
          ${(values as { ownerType: number }).ownerType}, ${(values as { studentId: string | null }).studentId},
          ${(values as { staffId: string | null }).staffId}, 'Form', ${(values as { fileId: string }).fileId})`.execute(
          tx,
        ),
      institutionIds,
    );
  const audit = async (entityId: string) =>
    (
      await readAuditRows<{
        action: string;
        entity_type: string;
        institution_id: string | null;
        old_values: unknown;
        new_values: unknown;
      }>(ownerDb, sql`entity_id = ${entityId}`)
    ).map((e) => ({
      action: e.action,
      entityType: e.entity_type,
      institutionId: e.institution_id,
      before: e.old_values,
      after: e.new_values,
    }));

  const ticket = async (fields: object = {}, token = owner.token) => {
    const res = await api('post', '/v1/files/uploads', token, {
      purpose: 5,
      institutionId: first,
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      fileName: 'admission-form.pdf',
      ...fields,
    });
    return succeeded(res, 201, 'upload ticket').body.data as unknown as Ticket;
  };
  const send = (given: Ticket, bytes: Buffer, contentType: string) => {
    const req = request(t.app.getHttpServer()).post(new URL(given.upload.url).pathname);
    for (const [name, value] of Object.entries(given.upload.fields)) req.field(name, value);
    return req.attach('file', bytes, { filename: 'upload', contentType });
  };
  /** A Ready file: asked for, sent, confirmed. */
  const readyFile = async (fields: object = {}, bytes = PDF, type = 'application/pdf') => {
    const given = await ticket({ contentType: type, sizeBytes: bytes.length, ...fields });
    expect((await send(given, bytes, type)).status).toBe(204);
    succeeded(await api('post', `/v1/files/${given.fileId}/confirm`, owner.token), 200, 'confirm');
    return given.fileId;
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
    const classes = await kit.masters(admin, 'predefined-classes');
    const sectionCodes = await kit.masters(admin, 'predefined-sections');
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
    diya = await admit(place);
    ravi = await admit(place);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('STU-06 block and STU-07 unblock', () => {
    it('blocks one student, stamps who and when, moves the version and audits it', async () => {
      const before = await profile(diya);
      expect([before.isBlocked, before.blockedAt]).toEqual([false, null]);
      const res = await block(diya);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: diya.id,
        isBlocked: true,
        version: before.version + 1,
        status: 1,
      });
      expect(typeof res.body.data.blockedAt).toBe('string');
      expect(await stored(diya)).toMatchObject({
        access_blocked_by: owner.person,
        version: before.version + 1,
        updated_by: owner.person,
      });
      expect(await audit(diya.id)).toContainEqual(
        expect.objectContaining({
          action: 'student.blocked',
          entityType: 'student',
          institutionId: first,
          before: { isBlocked: false },
          after: { isBlocked: true },
        }),
      );
    });

    it('stamps the Institution Admin who blocks as the one who updated the student', async () => {
      expect((await block(diya, institutionAdmin.token)).status).toBe(200);
      expect(await stored(diya)).toMatchObject({
        access_blocked_by: institutionAdmin.person,
        updated_by: institutionAdmin.person,
      });
      expect((await unblock(diya, owner.token)).status).toBe(200);
      expect(await stored(diya)).toMatchObject({ updated_by: owner.person });
    });

    it('stops that child only: the sibling, the guardians and the list keep working', async () => {
      await block(diya);
      expect((await profile(ravi)).isBlocked).toBe(false);
      const list = await api('get', '/v1/students', owner.token);
      const rows = list.body.data as unknown as { id: string; isBlocked: boolean }[];
      expect(rows.find((s) => s.id === diya.id)?.isBlocked).toBe(true);
      expect(rows.find((s) => s.id === ravi.id)?.isBlocked).toBe(false);
      const guardians = await api('get', `/v1/students/${diya.id}/guardians`, owner.token);
      expect(guardians.status).toBe(200);
      expect(
        (guardians.body.data as unknown as { hasLogin: boolean }[]).every((g) => g.hasLogin),
      ).toBe(true);
      expect((await api('get', '/v1/students', institutionAdmin.token)).status).toBe(200);
    });

    it('lifts the block, clears who and when, and audits the lift', async () => {
      await block(diya);
      const res = await unblock(diya);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ isBlocked: false, blockedAt: null });
      expect(await stored(diya)).toMatchObject({
        access_blocked_at: null,
        access_blocked_by: null,
      });
      expect((await audit(diya.id)).map((e) => e.action)).toEqual(
        expect.arrayContaining(['student.blocked', 'student.unblocked']),
      );
    });

    it('is 409 INVALID_STATE for a block on a blocked student and a lift on one that is not, and writes nothing', async () => {
      const lift = await unblock(diya);
      expect([lift.status, lift.body.code]).toEqual([409, 'INVALID_STATE']);
      await block(diya);
      const again = await block(diya);
      expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
      expect((await stored(diya)).version).toBe(2);
      expect((await audit(diya.id)).filter((e) => e.action === 'student.blocked')).toHaveLength(1);
    });

    it('lets two requests block one student: one wins, the other is 409', async () => {
      const [a, b] = await Promise.all([block(diya), block(diya)]);
      expect([a.status, b.status].toSorted()).toEqual([200, 409]);
      expect((await stored(diya)).version).toBe(2);
    });

    it('moves the version, so an edit made on the old profile is 409 VERSION_CONFLICT', async () => {
      const seen = await profile(diya);
      await block(diya);
      const res = await api('patch', `/v1/students/${diya.id}`, owner.token, {
        version: seen.version,
        nationality: 'Indian',
      });
      expect([res.status, res.body.code]).toEqual([409, 'VERSION_CONFLICT']);
    });

    it('is 404 for a deactivated student, for another Institution’s and for a stranger', async () => {
      await api('delete', `/v1/students/${ravi.id}?reason=1`, owner.token);
      expect((await block(ravi)).status).toBe(404);
      expect((await unblock(ravi)).status).toBe(404);
      const abroad = await admit(placeAtSecond);
      expect((await block(abroad, institutionAdmin.token)).status).toBe(404);
      const otherOwner = await fixtures.owner(await kit.society(admin));
      expect((await block(diya, otherOwner.token)).status).toBe(404);
      expect((await api('post', '/v1/students/not-a-uuid/block', owner.token)).status).toBe(404);
    });

    it('is for the Owner and the Admins of the child’s Institution, and no teacher or Super Admin', async () => {
      const teacher = await kit.staff(owner.token, first, categoryId, { firstName: 'Ana' });
      const asTeacher = await kit.actingAs(teacher.person.email, TEACHER, societyId);
      expect((await block(diya, asTeacher)).status).toBe(403);
      expect((await block(diya, admin)).status).toBe(403);
      expect((await block(diya, institutionAdmin.token)).status).toBe(200);
      expect((await unblock(diya, institutionAdmin.token)).status).toBe(200);
      expect((await profile(diya)).isBlocked).toBe(false);
    });

    it('keeps its own columns: both are set or both are empty', async () => {
      await expect(
        read((tx) =>
          sql`update students set access_blocked_at = now() where id = ${diya.id}`.execute(tx),
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'ck_students_access_block' });
    });
  });

  describe('DOC-02 attach, DOC-01 list, DOC-03 deactivate', () => {
    it('attaches a Ready student-document file and shows it on the Documents tab', async () => {
      const fileId = await readyFile();
      const res = await attach(diya, { title: 'Admission form', fileId });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        ownerType: 'student',
        studentId: diya.id,
        title: 'Admission form',
        file: {
          id: fileId,
          contentType: 'application/pdf',
          sizeBytes: PDF.length,
          fileName: 'admission-form.pdf',
        },
        createdBy: { id: owner.person },
      });
      expect(res.body.data).not.toHaveProperty('staffMemberId');
      expect(await listed(diya)).toEqual([expect.objectContaining({ id: res.body.data.id })]);
      expect(await audit(res.body.data.id)).toContainEqual(
        expect.objectContaining({
          action: 'document.created',
          institutionId: first,
          after: { studentId: diya.id, title: 'Admission form', fileId },
        }),
      );
      expect(await listed(ravi)).toEqual([]);
    });

    it('lists the newest first', async () => {
      const one = await attach(diya, { title: 'One', fileId: await readyFile() });
      const two = await attach(diya, { title: 'Two', fileId: await readyFile() });
      expect((await listed(diya)).map((d) => d.id)).toEqual([two.body.data.id, one.body.data.id]);
    });

    it('takes only a Ready student-document file: another purpose or a Pending one is 400, another Institution’s is not seen', async () => {
      const staffLetter = await readyFile({ purpose: 6 });
      const photo = await readyFile(
        { purpose: 3, contentType: 'image/jpeg', fileName: 'p.jpg' },
        JPEG,
        'image/jpeg',
      );
      const pending = (await ticket()).fileId;
      for (const fileId of [staffLetter, photo, pending]) {
        const res = await attach(diya, { title: 'Form', fileId });
        expect([res.status, res.body.errors?.[0]?.field, res.body.errors?.[0]?.code]).toEqual([
          400,
          'fileId',
          'INVALID_VALUE',
        ]);
      }
      const elsewhere = await readyFile({ institutionId: second });
      for (const fileId of [elsewhere, '0192f3b0-0000-7000-8000-000000000001']) {
        expect((await attach(diya, { title: 'Form', fileId })).status).toBe(404);
      }
      expect(await listed(diya)).toEqual([]);
    });

    it('attaches a file once, a deactivated document included', async () => {
      const fileId = await readyFile();
      const made = await attach(diya, { title: 'Form', fileId });
      expect((await attach(ravi, { title: 'Again', fileId })).body.code).toBe('DUPLICATE');
      expect((await api('delete', `/v1/documents/${made.body.data.id}`, owner.token)).status).toBe(
        200,
      );
      const again = await attach(diya, { title: 'Again', fileId });
      expect([again.status, again.body.code]).toEqual([409, 'DUPLICATE']);
    });

    it('checks the body', async () => {
      const fileId = await readyFile();
      expect((await attach(diya, { fileId })).status).toBe(400);
      expect((await attach(diya, { title: '   ', fileId })).status).toBe(400);
      expect((await attach(diya, { title: 'x'.repeat(151), fileId })).status).toBe(400);
      expect((await attach(diya, { title: 'Form' })).status).toBe(400);
      const extra = await attach(diya, { title: 'Form', fileId, ownerType: 2 });
      expect([extra.status, extra.body.errors?.[0]?.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    });

    it('answers 404 for a deactivated student, but keeps its documents for the admins who read them', async () => {
      const made = await attach(diya, { title: 'Form', fileId: await readyFile() });
      await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token);
      expect((await attach(diya, { title: 'More', fileId: await readyFile() })).status).toBe(404);
      expect((await listed(diya)).map((d) => d.id)).toEqual([made.body.data.id]);
    });

    it('is for the admins of the child’s Institution; a teacher, a Super Admin and strangers are refused', async () => {
      const made = await attach(diya, { title: 'Form', fileId: await readyFile() });
      const teacher = await kit.staff(owner.token, first, categoryId, { firstName: 'Ana' });
      const asTeacher = await kit.actingAs(teacher.person.email, TEACHER, societyId);
      expect((await documents(diya, asTeacher)).status).toBe(403);
      expect(
        (await attach(diya, { title: 'Mine', fileId: await readyFile() }, asTeacher)).status,
      ).toBe(403);
      expect((await documents(diya, admin)).status).toBe(403);
      expect((await listed(diya, institutionAdmin.token)).map((d) => d.id)).toEqual([
        made.body.data.id,
      ]);
      const abroad = await admit(placeAtSecond);
      expect((await documents(abroad, institutionAdmin.token)).status).toBe(404);
      expect(
        (
          await attach(
            abroad,
            { title: 'Form', fileId: await readyFile({ institutionId: second }) },
            institutionAdmin.token,
          )
        ).status,
      ).toBe(404);
      const otherOwner = await fixtures.owner(await kit.society(admin));
      expect((await documents(diya, otherOwner.token)).status).toBe(404);
    });

    it('lets the admins open the file with an audited link, and no teacher', async () => {
      const fileId = await readyFile();
      await attach(diya, { title: 'Form', fileId });
      const link = await open(fileId, owner.token);
      expect(link.status).toBe(200);
      expect(await audit(fileId)).toContainEqual(
        expect.objectContaining({ action: 'file.download' }),
      );
      const teacher = await kit.staff(owner.token, first, categoryId, { firstName: 'Ana' });
      const asTeacher = await kit.actingAs(teacher.person.email, TEACHER, societyId);
      expect((await open(fileId, asTeacher)).status).toBe(404);
    });

    it('deactivates a document of a student: it leaves the list, nothing is deleted, and a second call is 404', async () => {
      const made = await attach(diya, { title: 'Form', fileId: await readyFile() });
      const id = made.body.data.id as string;
      const res = await api('delete', `/v1/documents/${id}`, owner.token);
      expect([res.status, res.body.data]).toEqual([200, { id, status: 0 }]);
      expect(await listed(diya)).toEqual([]);
      expect((await api('delete', `/v1/documents/${id}`, owner.token)).status).toBe(404);
      const abroad = await admit(placeAtSecond);
      const theirs = await attach(abroad, {
        title: 'Form',
        fileId: await readyFile({ institutionId: second }),
      });
      expect(
        (await api('delete', `/v1/documents/${theirs.body.data.id}`, institutionAdmin.token))
          .status,
      ).toBe(404);
      expect((await audit(id)).map((e) => e.action)).toContain('document.deactivated');
    });
  });

  describe('the rules the database keeps itself', () => {
    it('refuses a document with the wrong owner columns for its type', async () => {
      const fileId = await readyFile();
      const staff: SchoolStaff = await kit.staff(owner.token, first, categoryId, {
        firstName: 'Ana',
      });
      for (const values of [
        { ownerType: 1, studentId: null, staffId: null, fileId },
        { ownerType: 1, studentId: diya.id, staffId: staff.id, fileId },
        { ownerType: 2, studentId: diya.id, staffId: staff.id, fileId },
        { ownerType: 2, studentId: diya.id, staffId: null, fileId },
      ]) {
        await expect(insert(values)).rejects.toMatchObject({
          code: '23514',
          constraint: 'ck_documents_owner',
        });
      }
    });

    it('keeps a document in its student’s Institution: a composite key and row-level security', async () => {
      const abroad = await admit(placeAtSecond);
      const fileId = await readyFile();
      // The session reaches both Institutions, so only the key refuses a student of the second one under the first.
      await expect(
        insert({ ownerType: 1, studentId: abroad.id, staffId: null, fileId }, [first, second]),
      ).rejects.toMatchObject({ code: '23503', constraint: 'fk_documents_student' });
      const elsewhere = await readyFile({ institutionId: second });
      await expect(
        read(
          (tx) =>
            sql`insert into documents (society_id, institution_id, owner_type, student_id, title, file_id)
              values (${societyId}, ${second}, 1, ${abroad.id}, 'Form', ${elsewhere})`.execute(tx),
          [first],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('runs the migration down with student documents on file: they go, the staff documents stay, and up brings the columns back', async () => {
      await attach(diya, { title: 'Form', fileId: await readyFile() });
      const teacher = await kit.staff(owner.token, first, categoryId, { firstName: 'Ana' });
      const letter = await api('post', `/v1/staff/${teacher.id}/documents`, owner.token, {
        title: 'Letter',
        fileId: await readyFile({ purpose: 6 }),
      });
      expect(letter.status).toBe(201);
      await ownerDb.transaction().execute(async (tx) => {
        await down(tx);
        await up(tx);
      });
      expect(await listed(diya)).toEqual([]);
      const kept = await api('get', `/v1/staff/${teacher.id}/documents`, owner.token);
      expect((kept.body.data as unknown as { id: string }[]).map((d) => d.id)).toEqual([
        letter.body.data.id,
      ]);
      const again = await attach(diya, { title: 'Form again', fileId: await readyFile() });
      expect(again.status).toBe(201);
    });

    it('lets the application change only the status of a document, and never delete one', async () => {
      const made = await attach(diya, { title: 'Form', fileId: await readyFile() });
      const id = made.body.data.id as string;
      for (const statement of [
        sql`update documents set title = 'Changed' where id = ${id}`,
        sql`update documents set student_id = ${ravi.id} where id = ${id}`,
        sql`delete from documents where id = ${id}`,
      ]) {
        await expect(read((tx) => statement.execute(tx), [first])).rejects.toMatchObject({
          code: '42501',
        });
      }
    });
  });
});
