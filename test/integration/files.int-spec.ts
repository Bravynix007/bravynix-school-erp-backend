import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { readFileRows } from '../support/file-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(60, 2)]);

interface Ticket {
  fileId: string;
  upload: { url: string; fields: Record<string, string>; expiresAt: string };
  maxBytes: number;
}

describe('FIL-01 to FIL-03 files (API design 15)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];

  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let societyA: string;
  let first: string;
  let second: string;

  const makeSociety = async () => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    societies.push(res.body.data.id);
    return res.body.data.id;
  };

  const makeInstitution = async (token: string) => {
    const res = await api('post', '/v1/institutions', token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };

  const ask = (fields: object = {}, token = owner.token, institutionId = first) =>
    api('post', '/v1/files/uploads', token, {
      purpose: 3,
      institutionId,
      contentType: 'image/jpeg',
      sizeBytes: JPEG.length,
      fileName: 'photo.jpg',
      ...fields,
    });

  /** Asks for an upload; the answer is the ticket. */
  const ticket = async (fields: object = {}, token = owner.token, institutionId = first) => {
    const res = await ask(fields, token, institutionId);
    expect(res.status).toBe(201);
    return res.body.data as unknown as Ticket;
  };

  /** Sends the bytes to the address of a ticket, the way the app does. */
  const send = (given: Ticket, bytes: Buffer, contentType: string) => {
    const req = request(t.app.getHttpServer()).post(new URL(given.upload.url).pathname);
    for (const [name, value] of Object.entries(given.upload.fields)) req.field(name, value);
    return req.attach('file', bytes, { filename: 'upload', contentType });
  };

  const confirm = (fileId: string, token = owner.token) =>
    api('post', `/v1/files/${fileId}/confirm`, token);
  const link = (fileId: string, token = owner.token) =>
    api('get', `/v1/files/${fileId}/download`, token);

  /** A Ready file of the purpose, uploaded by the token's person. */
  const ready = async (fields: object, bytes: Buffer, token = owner.token) => {
    const given = await ticket(fields, token);
    const type = (fields as { contentType?: string }).contentType ?? 'image/jpeg';
    expect((await send(given, bytes, type)).status).toBe(204);
    const res = await confirm(given.fileId, token);
    expect(res.status).toBe(200);
    return given.fileId;
  };

  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      society_id: string;
      institution_id: string | null;
      entity_type: string;
    }>(ownerDb, sql`entity_id = ${entityId}`);

  const row = async (id: string) => {
    const stored = await readFileRows<{
      file_status: number;
      checksum_sha256: Buffer | null;
      delete_after: Date | null;
      original_filename: string | null;
      object_key: string;
    }>(ownerDb, id);
    expect(stored).toBeDefined();
    return stored!;
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
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    societyA = await makeSociety();
    owner = await fixtures.owner(societyA);
    first = await makeInstitution(owner.token);
    second = await makeInstitution(owner.token);
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
    otherOwner = await fixtures.owner(await makeSociety());
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    await fixtures.cleanup();
  });

  describe('the whole flow: ask, send, confirm, fetch', () => {
    it('stores a photo, makes it Ready with its checksum, and serves it as an attachment of its own type', async () => {
      const given = await ticket();
      expect(given.maxBytes).toBe(5_242_880);
      expect(given.upload.fields).toEqual({});
      expect(await row(given.fileId)).toMatchObject({ file_status: 1, original_filename: null });

      expect((await send(given, JPEG, 'image/jpeg')).status).toBe(204);
      const confirmed = await confirm(given.fileId);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data).toEqual({
        id: given.fileId,
        purpose: 3,
        contentType: 'image/jpeg',
        sizeBytes: JPEG.length,
        fileStatus: 2,
      });
      expect(JSON.stringify(confirmed.body)).not.toContain('object_key');
      const stored = await row(given.fileId);
      expect(stored).toMatchObject({ file_status: 2, delete_after: null });
      expect(stored.checksum_sha256?.length).toBe(32);

      const fetched = await link(given.fileId);
      expect(fetched.status).toBe(200);
      const url = (fetched.body.data as unknown as { url: string }).url;
      const download = await request(t.app.getHttpServer()).get(new URL(url).pathname).buffer();
      expect(download.status).toBe(200);
      expect(download.headers['content-type']).toBe('image/jpeg');
      expect(download.headers['content-disposition']).toMatch(/^attachment/);
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(download.body as Buffer).equals(JPEG)).toBe(true);
    });

    it('keeps the name of a document, audits its link, and a photo’s link is not audited', async () => {
      const document = await ready(
        {
          purpose: 5,
          contentType: 'application/pdf',
          sizeBytes: PDF.length,
          fileName: '../form 1.pdf',
        },
        PDF,
      );
      expect((await row(document)).original_filename).toBe('form 1.pdf');
      expect((await link(document)).status).toBe(200);
      const [entry, ...rest] = await audit(document);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        action: 'file.download',
        entity_type: 'file',
        actor_user_id: owner.person,
        society_id: societyA,
        institution_id: first,
      });

      const photo = await ready({ sizeBytes: JPEG.length }, JPEG);
      expect((await link(photo)).status).toBe(200);
      expect(await audit(photo)).toEqual([]);
    });

    it('keeps an import for seven days', async () => {
      const csv = Buffer.from('Name,RollNumber,Class,Section\nAsha,1,5,A\n');
      const id = await ready(
        { purpose: 12, contentType: 'text/csv', sizeBytes: csv.length, fileName: 'students.csv' },
        csv,
      );
      const { delete_after } = await row(id);
      const days = (delete_after!.getTime() - t.clock.now().getTime()) / 86_400_000;
      expect(days).toBeCloseTo(7, 1);
    });
  });

  describe('FIL-01 asking', () => {
    it('is for an Owner, and an Admin of the Institution, and nobody else', async () => {
      expect((await ask({}, institutionAdmin.token)).status).toBe(201);
      expect((await ask({}, admin)).status).toBe(403);
    });

    it('refuses an Institution the caller does not reach, another Society’s, and one that does not exist, as 404', async () => {
      expect((await ask({}, institutionAdmin.token, second)).status).toBe(404);
      expect((await ask({}, otherOwner.token, first)).status).toBe(404);
      expect((await ask({}, owner.token, missing)).status).toBe(404);
    });

    it('refuses more than 5 MB (413) and a type the purpose does not take (415), and writes nothing', async () => {
      const big = await ask({ sizeBytes: 5_242_881 });
      expect(big.status).toBe(413);
      expect(big.body.code).toBe('FILE_TOO_LARGE');
      const pdf = await ask({ contentType: 'application/pdf' });
      expect(pdf.status).toBe(415);
      expect(pdf.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
      expect((await ask({ purpose: 12, contentType: 'image/png' })).status).toBe(415);
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from files`.execute(
        ownerDb,
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('refuses a purpose that does not exist, and a field the contract does not have', async () => {
      const purpose = await ask({ purpose: 99 });
      expect(purpose.status).toBe(400);
      expect(purpose.body.errors).toContainEqual(
        expect.objectContaining({ field: 'purpose', code: 'INVALID_CODE' }),
      );
      const owned = await ask({ owner: { type: 'student', id: missing } });
      expect(owned.status).toBe(400);
    });
  });

  describe('FIL-02 confirming', () => {
    it('is 422 UPLOAD_NOT_FOUND before the file arrives, and works once it has', async () => {
      const given = await ticket();
      const early = await confirm(given.fileId);
      expect(early.status).toBe(422);
      expect(early.body.code).toBe('UPLOAD_NOT_FOUND');
      await send(given, JPEG, 'image/jpeg');
      expect((await confirm(given.fileId)).status).toBe(200);
    });

    it('is 409 the second time', async () => {
      const id = await ready({}, JPEG);
      const again = await confirm(id);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_CONFIRMED');
    });

    it('discards a file that is not its declared type: 422, the object is gone, and the file no longer exists', async () => {
      const given = await ticket();
      await send(given, PDF, 'image/jpeg');
      const res = await confirm(given.fileId);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FILE_CHECK_FAILED');
      expect((await row(given.fileId)).file_status).toBe(3);
      expect((await confirm(given.fileId)).status).toBe(404);
      expect((await link(given.fileId)).status).toBe(404);
    });

    it('discards a file of another size than declared', async () => {
      const given = await ticket({ sizeBytes: JPEG.length + 1 });
      await send(given, JPEG, 'image/jpeg');
      expect((await confirm(given.fileId)).body.code).toBe('FILE_CHECK_FAILED');
    });

    it('is for the uploader alone: an Admin, another Society’s Owner and Super Admin get 404', async () => {
      const given = await ticket();
      await send(given, JPEG, 'image/jpeg');
      expect((await confirm(given.fileId, institutionAdmin.token)).status).toBe(404);
      expect((await confirm(given.fileId, otherOwner.token)).status).toBe(404);
      expect((await confirm(given.fileId, admin)).status).toBe(403);
      expect((await confirm(missing)).status).toBe(404);
      expect((await confirm(given.fileId)).status).toBe(200);
    });
  });

  describe('FIL-03 the link', () => {
    it('is for the uploader and for an Owner or Admin who reaches the Institution', async () => {
      const id = await ready({}, JPEG, institutionAdmin.token);
      expect((await link(id, institutionAdmin.token)).status).toBe(200);
      expect((await link(id, owner.token)).status).toBe(200);
    });

    it('is 404 for an Admin who does not reach the Institution, another Society’s Owner, and a file not Ready', async () => {
      const id = await ready({}, JPEG);
      const otherAdmin = await fixtures.institutionAdmin(societyA, [second]);
      expect((await link(id, otherAdmin.token)).status).toBe(404);
      expect((await link(id, otherOwner.token)).status).toBe(404);
      const pending = await ticket();
      expect((await link(pending.fileId)).status).toBe(404);
      expect((await link(missing)).status).toBe(404);
    });
  });

  describe('the local store’s own addresses', () => {
    it('refuses a forged address, an expired ticket and a link used the wrong way', async () => {
      const http = () => request(t.app.getHttpServer());
      expect((await http().get('/v1/local-storage/forged.token')).status).toBe(403);
      const given = await ticket();
      const path = new URL(given.upload.url).pathname;
      expect((await http().get(path)).status).toBe(405);
      t.clock.set(new Date(t.clock.now().getTime() + 301_000));
      expect((await send(given, JPEG, 'image/jpeg')).status).toBe(403);
    });

    it('refuses a file of another type than the ticket, one over the limit and a request with no file', async () => {
      const given = await ticket();
      expect((await send(given, JPEG, 'image/png')).status).toBe(400);
      expect(
        (
          await request(t.app.getHttpServer())
            .post(new URL(given.upload.url).pathname)
            .field('a', 'b')
        ).status,
      ).toBe(400);
      expect(
        (await send(given, Buffer.concat([JPEG, Buffer.alloc(5_242_880)]), 'image/jpeg')).status,
      ).toBe(413);
      expect((await confirm(given.fileId)).body.code).toBe('UPLOAD_NOT_FOUND');
    });
  });

  describe('row-level security', () => {
    it('shows a Society’s files to its own tenant and to no other', async () => {
      const id = await ready({}, JPEG);
      const count = (tenant: { personId: string; societyId: string; institutionIds: string[] }) =>
        database.transaction({ ...tenant, roleCode: 2 }, async (tx) => {
          const { rows } = await sql<{
            n: number;
          }>`select count(*)::int as n from files where id = ${id}`.execute(tx);
          return rows[0]!.n;
        });
      expect(
        await count({ personId: owner.person, societyId: societyA, institutionIds: [first] }),
      ).toBe(1);
      expect(
        await count({ personId: owner.person, societyId: societyA, institutionIds: [second] }),
      ).toBe(0);
      expect(
        await count({
          personId: otherOwner.person,
          societyId: otherOwner.contexts[0]!.societyId!,
          institutionIds: [first],
        }),
      ).toBe(0);
    });
  });
});
