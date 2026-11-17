import { Kysely, PostgresDialect, sql } from 'kysely';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import * as blocks from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import {
  SchoolKit,
  succeeded,
  type SchoolStudent,
  type StudentPlace,
} from '../support/school-kit.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const PARENT = 5;

const mail = () => `${Math.random().toString(36).slice(2)}@parent.test`;
const guardian = (email: string) => ({
  firstName: 'Ravi',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  email,
  isPrimary: true,
  isEmergencyContact: true,
});

/** DOC-01 and FIL-03 for a parent (API design 15.2): the photo and the documents of their own child, and no other file. */
describe('a parent opens the photo and the documents of their own child', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;
  let owner: SignedInPerson;
  let societyId: string;
  let institution: string;
  let place: StudentPlace;
  let ravi: string;
  let diya: SchoolStudent;
  let arjun: SchoolStudent;
  let stranger: SchoolStudent;
  let diyaPhoto: string;
  let diyaForm: string;
  let strangerForm: string;
  let token: string;

  const parentOf = (childIds: string[]) => ({ personId: owner.person, roleCode: PARENT, childIds });
  const open = (fileId: string, bearer = token) =>
    api('get', `/v1/files/${fileId}/download`, bearer);
  const documents = (student: SchoolStudent, bearer = token) =>
    api('get', `/v1/students/${student.id}/documents`, bearer);
  const attach = async (student: SchoolStudent, title: string, fileId: string) =>
    succeeded(
      await api('post', `/v1/students/${student.id}/documents`, owner.token, { title, fileId }),
      201,
      'attach',
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
    const classes = await kit.masters(admin, 'predefined-classes');
    const sectionCodes = await kit.masters(admin, 'predefined-sections');
    societyId = await kit.society(admin);
    owner = await fixtures.owner(societyId);
    institution = await kit.institution(owner.token, categoryId);
    const academicYearId = await kit.year(owner.token, institution);
    const classId = await kit.klass(
      owner.token,
      institution,
      classes.find((c) => c.code === 'C09')!.id,
    );
    const sectionId = await kit.section(
      owner.token,
      classId,
      sectionCodes.find((c) => c.code === 'A')!.id,
    );
    place = { academicYearId, classId, sectionId };
    ravi = mail();
    diyaPhoto = await kit.readyFile(owner.token, institution, { purpose: 3 }, true);
    diya = await kit.student(owner.token, institution, place, {
      firstName: 'Diya',
      photoFileId: diyaPhoto,
      guardians: [guardian(ravi)],
    });
    arjun = await kit.student(owner.token, institution, place, {
      firstName: 'Arjun',
      guardians: [guardian(ravi)],
    });
    stranger = await kit.student(owner.token, institution, place, { firstName: 'Kiran' });
    diyaForm = await kit.readyFile(owner.token, institution);
    strangerForm = await kit.readyFile(owner.token, institution);
    await attach(diya, 'Admission form', diyaForm);
    await attach(stranger, 'Admission form', strangerForm);
    const login = await signInMobile(t, ravi);
    token = login.accessToken;
  });

  afterEach(async () => {
    await blocks.clearBlocks(ownerDb);
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('DOC-01', () => {
    it('lists the active documents of their own child, with the file, and a sibling’s own', async () => {
      const own = await documents(diya);
      expect(own.status).toBe(200);
      expect(
        (own.body.data as unknown as { title: string; studentId: string }[]).map((d) => [
          d.title,
          d.studentId,
        ]),
      ).toEqual([['Admission form', diya.id]]);
      expect((await documents(arjun)).body.data).toEqual([]);
    });

    it('is 404 for a child who is not theirs, and 403 CHILD_ACCESS_BLOCKED for a blocked child', async () => {
      expect((await documents(stranger)).status).toBe(404);
      succeeded(await api('post', `/v1/students/${diya.id}/block`, owner.token, {}), 200, 'block');
      const refused = await documents(diya);
      expect([refused.status, refused.body.code]).toEqual([403, 'CHILD_ACCESS_BLOCKED']);
      expect((await documents(arjun)).status).toBe(200);
    });

    it('never lists a deactivated document', async () => {
      const [doc] = (await documents(diya)).body.data as unknown as { id: string }[];
      succeeded(await api('delete', `/v1/documents/${doc!.id}`, owner.token), 200, 'deactivate');
      expect((await documents(diya)).body.data).toEqual([]);
    });
  });

  describe('FIL-03', () => {
    it('gives a link to the photo and to a document of their own child, and audits the document', async () => {
      const photo = await open(diyaPhoto);
      expect(photo.status).toBe(200);
      expect(photo.body.data).toMatchObject({ url: expect.any(String) });
      const form = await open(diyaForm);
      expect(form.status).toBe(200);
      const entries = await readAuditRows<{ action: string; actor_user_id: string | null }>(
        ownerDb,
        sql`entity_id = ${diyaForm} and action = 'file.download'`,
      );
      expect(entries).toHaveLength(1);
    });

    it('is 404 for another child’s photo or document, a file that is neither, and a file that does not exist', async () => {
      const strangerPhoto = await kit.readyFile(owner.token, institution, { purpose: 3 }, true);
      succeeded(
        await api('patch', `/v1/students/${stranger.id}`, owner.token, {
          version: stranger.version,
          photoFileId: strangerPhoto,
        }),
        200,
        'photo',
      );
      const staffLetter = await kit.readyFile(owner.token, institution, { purpose: 6 });
      const unattached = await kit.readyFile(owner.token, institution);
      for (const fileId of [
        strangerPhoto,
        strangerForm,
        staffLetter,
        unattached,
        '01a1e4ff-120a-773c-862f-1c6e949cb33a',
      ]) {
        expect((await open(fileId)).status).toBe(404);
      }
    });

    it('is 403 CHILD_ACCESS_BLOCKED for a blocked child’s files and 423 while the Institution’s students are blocked', async () => {
      succeeded(await api('post', `/v1/students/${diya.id}/block`, owner.token, {}), 200, 'block');
      const refused = await open(diyaPhoto);
      expect([refused.status, refused.body.code]).toEqual([403, 'CHILD_ACCESS_BLOCKED']);
      succeeded(await api('post', `/v1/students/${diya.id}/unblock`, owner.token, {}), 200, 'lift');
      await blocks.setBlock(ownerDb, societyId, institution, 3, true);
      expect((await open(diyaPhoto)).status).toBe(423);
    });

    it('stops opening a document once it is deactivated, and once the link to the child ends', async () => {
      const [doc] = (await documents(diya)).body.data as unknown as { id: string }[];
      succeeded(await api('delete', `/v1/documents/${doc!.id}`, owner.token), 200, 'deactivate');
      expect((await open(diyaForm)).status).toBe(404);
      expect((await open(diyaPhoto)).status).toBe(200);
    });

    it('still serves the Owner, and refuses a person who guards nobody', async () => {
      expect((await open(diyaForm, owner.token)).status).toBe(200);
      const otherOwner = await fixtures.owner(await kit.society(admin));
      expect((await open(diyaForm, otherOwner.token)).status).toBe(404);
    });
  });

  describe('row-level security', () => {
    it('shows a parent request the files and documents of the named child only', async () => {
      const seen = await database.transaction(
        { personId: owner.person, roleCode: PARENT, childIds: [diya.id] },
        async (tx) => ({
          files: (await sql<{ id: string }>`select id from files order by id`.execute(tx)).rows.map(
            (r) => r.id,
          ),
          documents: (
            await sql<{ student_id: string }>`select student_id from documents`.execute(tx)
          ).rows.map((r) => r.student_id),
        }),
      );
      expect(seen.files).toEqual([diyaPhoto, diyaForm].toSorted());
      expect(seen.documents).toEqual([diya.id]);
    });

    it('shows a parent request neither the row nor the file of a document that was deactivated', async () => {
      const [form] = (await documents(diya)).body.data as unknown as { id: string }[];
      const kept = await kit.readyFile(owner.token, institution);
      await attach(diya, 'Report card', kept);
      succeeded(await api('delete', `/v1/documents/${form!.id}`, owner.token), 200, 'deactivate');
      const seen = await database.transaction(parentOf([diya.id]), async (tx) => ({
        files: (await sql<{ id: string }>`select id from files order by id`.execute(tx)).rows.map(
          (r) => r.id,
        ),
        documents: (await sql<{ id: string }>`select id from documents`.execute(tx)).rows.map(
          (r) => r.id,
        ),
      }));
      expect(seen.documents).not.toContain(form!.id);
      expect(seen.documents).toHaveLength(1);
      expect(seen.files).toEqual([diyaPhoto, kept].toSorted());
    });

    it('shows nothing without a child, for another role, and no write at all', async () => {
      const count = (tenant: Parameters<DatabaseService['transaction']>[0]) =>
        database.transaction(tenant, async (tx) => [
          (await sql<{ n: number }>`select count(*)::int as n from files`.execute(tx)).rows[0]!.n,
          (await sql<{ n: number }>`select count(*)::int as n from documents`.execute(tx)).rows[0]!
            .n,
        ]);
      expect(await count({ personId: owner.person, roleCode: PARENT })).toEqual([0, 0]);
      expect(await count({ personId: owner.person, roleCode: 4, childIds: [diya.id] })).toEqual([
        0, 0,
      ]);
      await expect(
        database.transaction(
          { personId: owner.person, roleCode: PARENT, childIds: [diya.id] },
          (tx) => sql`update files set original_filename = 'x' where id = ${diyaPhoto}`.execute(tx),
        ),
      ).resolves.toMatchObject({ numAffectedRows: 0n });
    });

    it('lets a parent request write an audit entry for its own child’s Society and Institution only, and read none', async () => {
      const entry = (society: string, institutionId: string) =>
        database.transaction(parentOf([diya.id]), (tx) =>
          sql`insert into audit_logs (action, society_id, institution_id)
            values ('qa.parent', ${society}, ${institutionId})`.execute(tx),
        );
      await expect(entry(societyId, institution)).resolves.toBeDefined();
      const other = await kit.society(admin);
      await expect(entry(other, institution)).rejects.toMatchObject({ code: '42501' });
      await expect(entry(societyId, '01a1e4ff-120a-773c-862f-1c6e949cb33a')).rejects.toMatchObject({
        code: '42501',
      });
      const none = await database.transaction(
        parentOf([diya.id]),
        async (tx) =>
          (await sql<{ n: number }>`select count(*)::int as n from audit_logs`.execute(tx)).rows[0]!
            .n,
      );
      expect(none).toBe(0);
    });
  });
});
