import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { DatabaseService, type Tx } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { dumpTables, readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, succeeded, type SchoolStaff } from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;
// Synthetic numbers that pass the check digit; they belong to no one.
const NUMBER = '2345 6789 0124';
const DIGITS = '234567890124';
const OTHER = '9876 5432 1096';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(60, 2)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);

/** The four columns of a sealed number, with a hash that is all one byte. */
const sealed = (hmacByte: number) => ({
  aadhaar_ciphertext: Buffer.from('sealed'),
  aadhaar_key_version: 1,
  aadhaar_hmac: Buffer.alloc(32, hmacByte),
  aadhaar_last4: '0124',
});

interface Ticket {
  fileId: string;
  upload: { url: string; fields: Record<string, string> };
}
interface DocumentBody {
  id: string;
  ownerType: string;
  staffMemberId: string;
  title: string;
  file: { id: string; contentType: string; sizeBytes: number; fileName: string | null };
  createdBy: { id: string | null; displayName: string };
}

/** STF-11, STF-12, STF-14, STF-15 and DOC-03 (API design 6.8, 10.5b, 10.9): the Aadhaar number and the documents of a staff member. */
describe('a staff member’s Aadhaar number and documents', () => {
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
  let ana: SchoolStaff;
  let bo: SchoolStaff;
  let cy: SchoolStaff;

  const identity = (staff: SchoolStaff, aadhaar: unknown, token = owner.token) =>
    api('put', `/v1/staff/${staff.id}/identity`, token, { aadhaar });
  const reveal = (staff: SchoolStaff, body: object = {}, token = owner.token) =>
    api('post', `/v1/staff/${staff.id}/identity/reveal`, token, {
      field: 'aadhaar',
      reason: 'Checking the number for the payroll file',
      ...body,
    });
  const documents = (staff: SchoolStaff, token = owner.token) =>
    api('get', `/v1/staff/${staff.id}/documents`, token);
  const attach = (staff: SchoolStaff, fields: object, token = owner.token) =>
    api('post', `/v1/staff/${staff.id}/documents`, token, fields);
  const listed = async (staff: SchoolStaff, token = owner.token) => {
    const res = await documents(staff, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as DocumentBody[];
  };

  const profile = (staff: SchoolStaff, token = owner.token) =>
    api('get', `/v1/staff/${staff.id}`, token);

  const open = (fileId: string, token: string) => api('get', `/v1/files/${fileId}/download`, token);
  const attached = async (staff: SchoolStaff, institutionId = first) => {
    const fileId = await readyFile({ institutionId });
    const made = await attach(staff, { title: 'Letter', fileId });
    expect(made.status).toBe(201);
    return { fileId, documentId: made.body.data.id as string };
  };

  const tenant = (institutionIds: string[], society = societyId) => ({
    personId: owner.person,
    roleCode: 2,
    societyId: society,
    institutionIds,
  });
  const seen = (institutionIds: string[]) =>
    database.transaction(tenant(institutionIds), async (tx) =>
      (await tx.selectFrom('documents').select('id').execute()).map((row) => row.id).toSorted(),
    );

  /** The rows of the tables as the Society's own session reads them. */
  const read = <T>(
    work: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<T>,
  ) =>
    database.transaction(
      { personId: owner.person, roleCode: 2, societyId, institutionIds: [first, second] },
      work,
    );
  const stored = (staff: SchoolStaff) =>
    read(
      async (tx) =>
        (
          await sql<{
            aadhaar_ciphertext: Buffer | null;
            aadhaar_key_version: number | null;
            aadhaar_hmac: Buffer | null;
            aadhaar_last4: string | null;
            version: number;
            created_by: string;
            text: string;
          }>`select i.*, i::text as text from staff_identities i where staff_member_id = ${staff.id}`.execute(
            tx,
          )
        ).rows[0],
    );
  const audit = async (entityId: string) =>
    (
      await readAuditRows<{
        action: string;
        entity_id: string;
        entity_type: string;
        institution_id: string | null;
        actor_user_id: string | null;
        reason: string | null;
        old_values: unknown;
        new_values: unknown;
      }>(ownerDb, sql`entity_id = ${entityId}`)
    ).map(
      ({
        action,
        entity_id,
        entity_type,
        institution_id,
        actor_user_id,
        reason,
        old_values,
        new_values,
      }) => ({
        action,
        entity_id,
        entityType: entity_type,
        institutionId: institution_id,
        actor: actor_user_id,
        reason,
        before: old_values,
        after: new_values,
      }),
    );

  const ticket = async (fields: object = {}, token = owner.token) => {
    const res = await api('post', '/v1/files/uploads', token, {
      purpose: 6,
      institutionId: first,
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      fileName: 'letter.pdf',
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
    societyId = await kit.society(admin);
    owner = await fixtures.owner(societyId);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    institutionAdmin = await fixtures.institutionAdmin(societyId, [first]);
    ana = await kit.staff(owner.token, first, categoryId, { firstName: 'Ana' });
    bo = await kit.staff(owner.token, first, categoryId, { firstName: 'Bo' });
    cy = await kit.staff(owner.token, second, categoryId, { firstName: 'Cy' });
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('STF-11 set the Aadhaar number', () => {
    it('seals the number, answers with the masked one and stores or logs it nowhere in the clear', async () => {
      const res = await identity(ana, NUMBER);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ aadhaarMasked: 'XXXX XXXX 0124' });

      const row = (await stored(ana))!;
      expect(row.aadhaar_last4).toBe('0124');
      expect(row.aadhaar_key_version).toBe(1);
      expect(row.aadhaar_hmac).toHaveLength(32);
      expect(row.aadhaar_ciphertext!.includes(Buffer.from(DIGITS))).toBe(false);
      expect(row.version).toBe(1);
      expect(row.created_by).toBe(owner.person);
      expect(row.text).not.toContain(DIGITS);
      const everything = await dumpTables(ownerDb, ['users', 'staff_members', 'files']);
      expect(everything).not.toContain(DIGITS);
      expect(everything).not.toContain(NUMBER);

      expect(await audit(ana.id)).toContainEqual(
        expect.objectContaining({
          action: 'identity.updated',
          before: { aadhaarMasked: null },
          after: { aadhaarMasked: 'XXXX XXXX 0124' },
        }),
      );
    });

    it('writes nothing for the same number again, however it is typed', async () => {
      await identity(ana, NUMBER);
      expect((await identity(ana, DIGITS)).body.data).toEqual({ aadhaarMasked: 'XXXX XXXX 0124' });
      expect((await identity(ana, '2345-6789-0124')).status).toBe(200);
      expect((await stored(ana))!.version).toBe(1);
      expect((await audit(ana.id)).filter((e) => e.action.startsWith('identity.'))).toHaveLength(1);
    });

    it('replaces the number with another and audits both, masked', async () => {
      await identity(ana, NUMBER);
      expect((await identity(ana, OTHER)).body.data).toEqual({ aadhaarMasked: 'XXXX XXXX 1096' });
      expect((await stored(ana))!.version).toBe(2);
      expect(await audit(ana.id)).toContainEqual(
        expect.objectContaining({
          action: 'identity.updated',
          before: { aadhaarMasked: 'XXXX XXXX 0124' },
          after: { aadhaarMasked: 'XXXX XXXX 1096' },
        }),
      );
    });

    it('clears the number with null, keeps the row, and then reveals nothing', async () => {
      await identity(ana, NUMBER);
      expect((await identity(ana, null)).body.data).toEqual({ aadhaarMasked: null });
      const row = (await stored(ana))!;
      expect([row.aadhaar_ciphertext, row.aadhaar_hmac, row.aadhaar_last4]).toEqual([
        null,
        null,
        null,
      ]);
      const version = row.version;
      expect((await identity(ana, null)).status).toBe(200);
      expect((await stored(ana))!.version).toBe(version);
      const none = await reveal(ana);
      expect([none.status, none.body.code]).toEqual([404, 'NOT_SET']);
      // The same number can be set again after it was cleared.
      expect((await identity(ana, NUMBER)).body.data).toEqual({ aadhaarMasked: 'XXXX XXXX 0124' });
    });

    it('answers 200 with no number when there was nothing to clear, and makes no row', async () => {
      expect((await identity(ana, null)).body.data).toEqual({ aadhaarMasked: null });
      expect(await stored(ana)).toBeUndefined();
    });

    it('refuses a number that is not an Aadhaar number with 422, and stores nothing', async () => {
      for (const bad of ['234567890125', '12', '0123 4567 8901', 'not a number']) {
        const res = await identity(ana, bad);
        expect([res.status, res.body.code]).toEqual([422, 'INVALID_AADHAAR']);
      }
      expect(await stored(ana)).toBeUndefined();
    });

    it('is strict about the body: a number is text, and the bank fields are not built', async () => {
      expect((await identity(ana, 234567890124)).status).toBe(400);
      expect((await api('put', `/v1/staff/${ana.id}/identity`, owner.token, {})).status).toBe(400);
      const bank = await api('put', `/v1/staff/${ana.id}/identity`, owner.token, {
        aadhaar: NUMBER,
        bankAccount: '123456789012',
        ifscCode: 'SBIN0001234',
        bankBranch: 'Main',
      });
      expect(bank.status).toBe(400);
      expect(bank.body.errors).toEqual(
        expect.arrayContaining([
          { field: 'bankAccount', code: 'FIELD_NOT_ALLOWED', message: expect.any(String) },
        ]),
      );
      expect(await stored(ana)).toBeUndefined();
    });

    it('keeps one record per number in the Society, without saying whose it is', async () => {
      await identity(ana, NUMBER);
      for (const holder of [bo, cy]) {
        const res = await identity(holder, DIGITS);
        expect([res.status, res.body.code]).toEqual([409, 'AADHAAR_EXISTS_IN_SOCIETY']);
        expect(JSON.stringify(res.body)).not.toContain(ana.id);
        expect(JSON.stringify(res.body)).not.toContain('Ana');
      }
      expect(await stored(bo)).toBeUndefined();
      // Another Society may hold the same number: the check is the Society's own.
      const otherSociety = await kit.society(admin);
      const otherOwner = await fixtures.owner(otherSociety);
      const school = await kit.institution(otherOwner.token, categoryId);
      const stranger = await kit.staff(otherOwner.token, school, categoryId, { firstName: 'Di' });
      expect((await identity(stranger, DIGITS, otherOwner.token)).status).toBe(200);
    });

    it('lets two requests claim one number: one wins, the other is 409', async () => {
      const [a, b] = await Promise.all([identity(ana, NUMBER), identity(bo, NUMBER)]);
      expect([a.status, b.status].toSorted()).toEqual([200, 409]);
    });

    it('takes the number from a deactivated record, which then holds none', async () => {
      await identity(ana, NUMBER);
      expect((await api('delete', `/v1/staff/${ana.id}`, owner.token)).status).toBe(200);
      expect((await identity(bo, NUMBER)).body.data).toEqual({ aadhaarMasked: 'XXXX XXXX 0124' });
      expect((await stored(ana))!.aadhaar_last4).toBeNull();
      const gone = await reveal(ana);
      expect([gone.status, gone.body.code]).toEqual([404, 'NOT_SET']);
      expect((await reveal(bo)).body.data.value).toBe(DIGITS);
      expect(await audit(ana.id)).toContainEqual(
        expect.objectContaining({
          action: 'identity.released',
          entityType: 'staff_identities',
          after: { aadhaarMasked: null, takenBy: bo.id },
        }),
      );
    });

    it('audits the release at the Institution of the record that lost the number, not of the one that took it', async () => {
      await identity(cy, NUMBER);
      expect((await api('delete', `/v1/staff/${cy.id}`, owner.token)).status).toBe(200);
      // An Admin of `first` does not reach `second`; the entry is still written where the lost number was kept.
      expect((await identity(ana, NUMBER, institutionAdmin.token)).status).toBe(200);
      expect(await audit(cy.id)).toContainEqual(
        expect.objectContaining({ action: 'identity.released', institutionId: second }),
      );
      expect(await audit(ana.id)).toContainEqual(
        expect.objectContaining({ action: 'identity.updated', institutionId: first }),
      );
    });

    it('audits the one row under one entity type, whether it is set, cleared or revealed', async () => {
      await identity(ana, NUMBER);
      expect((await reveal(ana)).status).toBe(200);
      await identity(ana, null);
      const entries = await audit(ana.id);
      expect(
        entries
          .filter((e) => e.action.startsWith('identity.'))
          .map((e) => [e.action, e.entityType]),
      ).toEqual([
        ['identity.updated', 'staff_identities'],
        ['identity.reveal', 'staff_identities'],
        ['identity.cleared', 'staff_identities'],
      ]);
    });

    it('is for the admins of the record’s Institution; a teacher, a Super Admin and strangers are refused', async () => {
      expect((await identity(ana, NUMBER, institutionAdmin.token)).status).toBe(200);
      expect((await identity(cy, NUMBER, institutionAdmin.token)).status).toBe(404);
      expect((await identity(ana, NUMBER, admin)).status).toBe(403);
      const teacher = await kit.actingAs(ana.person.email, TEACHER, societyId);
      expect((await identity(ana, OTHER, teacher)).status).toBe(403);
      const otherOwner = await fixtures.owner(await kit.society(admin));
      expect((await identity(ana, NUMBER, otherOwner.token)).status).toBe(404);
      expect(
        (await api('put', '/v1/staff/not-a-uuid/identity', owner.token, { aadhaar: null })).status,
      ).toBe(404);
    });

    it('answers 404 for a deactivated record', async () => {
      await api('delete', `/v1/staff/${ana.id}`, owner.token);
      expect((await identity(ana, NUMBER)).status).toBe(404);
    });
  });

  describe('STF-12 reveal the Aadhaar number', () => {
    it('gives the number once the entry with the reason is written, and never logs the number', async () => {
      await identity(ana, NUMBER);
      const res = await reveal(ana);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ field: 'aadhaar', value: DIGITS });
      expect(Number.isNaN(Date.parse(res.body.data.revealedAt as string))).toBe(false);
      expect(res.headers['cache-control']).toBe('no-store');
      const entries = (await audit(ana.id)).filter((e) => e.action === 'identity.reveal');
      expect(entries).toEqual([
        expect.objectContaining({ reason: 'Checking the number for the payroll file' }),
      ]);
      expect(await dumpTables(ownerDb, [])).not.toContain(DIGITS);
    });

    it('refuses what it cannot reveal: no number, the bank account, a short or missing reason', async () => {
      const none = await reveal(ana);
      expect([none.status, none.body.code]).toEqual([404, 'NOT_SET']);
      await identity(ana, NUMBER);
      expect((await reveal(ana, { field: 'bankAccount' })).status).toBe(400);
      const short = await reveal(ana, { reason: 'because' });
      expect(short.status).toBe(400);
      expect(short.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'reason', code: 'TOO_SHORT' })]),
      );
      expect((await reveal(ana, { reason: undefined })).status).toBe(400);
      expect((await audit(ana.id)).filter((e) => e.action === 'identity.reveal')).toEqual([]);
    });

    it('has one limit for the reason, 500: 501 is TOO_LONG and says max 500', async () => {
      await identity(ana, NUMBER);
      const long = await reveal(ana, { reason: 'x'.repeat(501) });
      expect(long.status).toBe(400);
      expect(long.body.errors).toEqual([
        expect.objectContaining({ field: 'reason', code: 'TOO_LONG' }),
      ]);
      expect(JSON.stringify(long.body)).toContain('"max":500');
      expect((await reveal(ana, { reason: 'x'.repeat(500) })).status).toBe(200);
    });

    it('stops an admin at ten a day with 429 and a wait', async () => {
      await identity(ana, NUMBER);
      for (let i = 0; i < 10; i += 1) expect((await reveal(ana)).status).toBe(200);
      const eleventh = await reveal(ana);
      expect([eleventh.status, eleventh.body.code]).toEqual([429, 'REVEAL_LIMIT']);
      expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('is for the admins of the record’s Institution, and works for a deactivated record', async () => {
      await identity(ana, NUMBER);
      const teacher = await kit.actingAs(ana.person.email, TEACHER, societyId);
      expect((await reveal(ana, {}, teacher)).status).toBe(403);
      expect((await reveal(ana, {}, admin)).status).toBe(403);
      expect((await reveal(cy, {}, institutionAdmin.token)).status).toBe(404);
      expect((await reveal(ana, {}, institutionAdmin.token)).body.data.value).toBe(DIGITS);
      await api('delete', `/v1/staff/${ana.id}`, owner.token);
      expect((await reveal(ana)).body.data.value).toBe(DIGITS);
    });
  });

  describe('STF-15 attach a document, STF-14 list, DOC-03 deactivate', () => {
    it('attaches a Ready staff-document file and shows it on the Documents tab', async () => {
      const fileId = await readyFile();
      const res = await attach(ana, { title: 'Appointment letter', fileId });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        ownerType: 'staff',
        staffMemberId: ana.id,
        title: 'Appointment letter',
        file: {
          id: fileId,
          contentType: 'application/pdf',
          sizeBytes: PDF.length,
          fileName: 'letter.pdf',
        },
        createdBy: { id: owner.person },
      });
      expect(await listed(ana)).toEqual([expect.objectContaining({ id: res.body.data.id })]);
      expect(await audit(res.body.data.id)).toContainEqual(
        expect.objectContaining({
          action: 'document.created',
          after: { staffMemberId: ana.id, title: 'Appointment letter', fileId },
        }),
      );
      expect(await listed(bo)).toEqual([]);
    });

    it('lists the newest first, and nothing for a record with no document', async () => {
      const one = await attach(ana, { title: 'One', fileId: await readyFile() });
      const two = await attach(ana, { title: 'Two', fileId: await readyFile() });
      expect((await listed(ana)).map((d) => d.id)).toEqual([two.body.data.id, one.body.data.id]);
      expect(await listed(cy)).toEqual([]);
    });

    it('takes only a Ready staff-document file: another purpose or a Pending one is 400, another Institution’s is not seen', async () => {
      const photo = await readyFile(
        { purpose: 3, contentType: 'image/jpeg', fileName: 'p.jpg' },
        JPEG,
        'image/jpeg',
      );
      const pending = (await ticket()).fileId;
      for (const fileId of [photo, pending]) {
        const res = await attach(ana, { title: 'Letter', fileId });
        expect([res.status, res.body.errors?.[0]?.field, res.body.errors?.[0]?.code]).toEqual([
          400,
          'fileId',
          'INVALID_VALUE',
        ]);
      }
      // The request reaches the home Institution only, so a file made for another one is not found.
      const elsewhere = await readyFile({ institutionId: second });
      for (const fileId of [elsewhere, '0192f3b0-0000-7000-8000-000000000001']) {
        expect((await attach(ana, { title: 'Letter', fileId })).status).toBe(404);
      }
      expect(await listed(ana)).toEqual([]);
    });

    it('attaches a file once, a deactivated document included', async () => {
      const fileId = await readyFile();
      const made = await attach(ana, { title: 'Letter', fileId });
      expect((await attach(bo, { title: 'Again', fileId })).body.code).toBe('DUPLICATE');
      expect((await api('delete', `/v1/documents/${made.body.data.id}`, owner.token)).status).toBe(
        200,
      );
      const again = await attach(ana, { title: 'Again', fileId });
      expect([again.status, again.body.code]).toEqual([409, 'DUPLICATE']);
    });

    it('checks the body', async () => {
      const fileId = await readyFile();
      expect((await attach(ana, { fileId })).status).toBe(400);
      expect((await attach(ana, { title: '   ', fileId })).status).toBe(400);
      expect((await attach(ana, { title: 'x'.repeat(151), fileId })).status).toBe(400);
      expect((await attach(ana, { title: 'Letter' })).status).toBe(400);
      const extra = await attach(ana, { title: 'Letter', fileId, ownerType: 1 });
      expect([extra.status, extra.body.errors?.[0]?.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    });

    it('answers 404 for a deactivated record, but keeps its documents for the admins who read them', async () => {
      const made = await attach(ana, { title: 'Letter', fileId: await readyFile() });
      await api('delete', `/v1/staff/${ana.id}`, owner.token);
      expect((await attach(ana, { title: 'More', fileId: await readyFile() })).status).toBe(404);
      expect((await listed(ana)).map((d) => d.id)).toEqual([made.body.data.id]);
    });

    it('is for the admins of the record’s Institution; a teacher reads their own list only', async () => {
      const made = await attach(ana, { title: 'Letter', fileId: await readyFile() });
      const teacher = await kit.actingAs(ana.person.email, TEACHER, societyId);
      expect(
        (await attach(ana, { title: 'Mine', fileId: await readyFile() }, teacher)).status,
      ).toBe(403);
      expect((await listed(ana, teacher)).map((d) => d.id)).toEqual([made.body.data.id]);
      expect((await documents(bo, teacher)).status).toBe(404);
      expect((await listed(ana, institutionAdmin.token)).map((d) => d.id)).toEqual([
        made.body.data.id,
      ]);
      expect((await documents(cy, institutionAdmin.token)).status).toBe(404);
      expect(
        (
          await attach(
            cy,
            { title: 'Letter', fileId: await readyFile({ institutionId: second }) },
            institutionAdmin.token,
          )
        ).status,
      ).toBe(404);
      expect((await documents(ana, admin)).status).toBe(403);
    });

    it('deactivates a document: it leaves the list, nothing is deleted, and a second call is 404', async () => {
      const made = await attach(ana, { title: 'Letter', fileId: await readyFile() });
      const id = made.body.data.id;
      const res = await api('delete', `/v1/documents/${id}`, owner.token);
      expect([res.status, res.body.data]).toEqual([200, { id, status: 0 }]);
      expect(await listed(ana)).toEqual([]);
      const row = await read(
        async (tx) =>
          (
            await sql<{
              status: number;
              updated_by: string;
            }>`select status, updated_by from documents where id = ${id}`.execute(tx)
          ).rows[0],
      );
      expect(row).toEqual({ status: 0, updated_by: owner.person });
      expect(await audit(id)).toContainEqual(
        expect.objectContaining({
          action: 'document.deactivated',
          before: { status: 1 },
          after: { status: 0 },
        }),
      );
      expect((await api('delete', `/v1/documents/${id}`, owner.token)).status).toBe(404);
    });

    it('is for the admins of the document’s Institution', async () => {
      const mine = await attach(ana, { title: 'Letter', fileId: await readyFile() });
      const theirs = await attach(cy, {
        title: 'Letter',
        fileId: await readyFile({ institutionId: second }),
      });
      const teacher = await kit.actingAs(ana.person.email, TEACHER, societyId);
      expect((await api('delete', `/v1/documents/${mine.body.data.id}`, teacher)).status).toBe(403);
      expect((await api('delete', `/v1/documents/${mine.body.data.id}`, admin)).status).toBe(403);
      expect(
        (await api('delete', `/v1/documents/${theirs.body.data.id}`, institutionAdmin.token))
          .status,
      ).toBe(404);
      expect((await api('delete', '/v1/documents/not-a-uuid', owner.token)).status).toBe(404);
      const otherOwner = await fixtures.owner(await kit.society(admin));
      expect(
        (await api('delete', `/v1/documents/${mine.body.data.id}`, otherOwner.token)).status,
      ).toBe(404);
      expect(
        (await api('delete', `/v1/documents/${mine.body.data.id}`, institutionAdmin.token)).status,
      ).toBe(200);
    });
  });

  describe('STF-03 shows the masked Aadhaar number to admins', () => {
    it('is null with no number, then follows STF-11: set, replaced, cleared', async () => {
      expect((await profile(ana)).body.data.aadhaarMasked).toBeNull();
      await identity(ana, NUMBER);
      expect((await profile(ana)).body.data.aadhaarMasked).toBe('XXXX XXXX 0124');
      expect((await profile(ana, institutionAdmin.token)).body.data.aadhaarMasked).toBe(
        'XXXX XXXX 0124',
      );
      await identity(ana, OTHER);
      expect((await profile(ana)).body.data.aadhaarMasked).toBe('XXXX XXXX 1096');
      await identity(ana, null);
      expect((await profile(ana)).body.data.aadhaarMasked).toBeNull();
    });

    it('is on the answer of the other admin calls, and never the number itself', async () => {
      await identity(ana, NUMBER);
      const edited = await api('patch', `/v1/staff/${ana.id}`, owner.token, {
        version: (await profile(ana)).body.data.version,
        firstName: 'Anna',
      });
      expect(edited.body.data.aadhaarMasked).toBe('XXXX XXXX 0124');
      expect(JSON.stringify(edited.body)).not.toContain(DIGITS);
    });

    it('is not on a teacher’s own profile', async () => {
      await identity(ana, NUMBER);
      const teacher = await kit.actingAs(ana.person.email, TEACHER, societyId);
      const own = await profile(ana, teacher);
      expect(own.status).toBe(200);
      expect(own.body.data).not.toHaveProperty('aadhaarMasked');
      expect(JSON.stringify(own.body)).not.toContain('0124');
    });
  });

  describe('FIL-03 for a teacher: the file of their own document', () => {
    it('gives a teacher a link to their own document’s file, and audits it', async () => {
      const { fileId } = await attached(ana);
      const teacher = await kit.actingAs(ana.person.email, TEACHER, societyId);
      const res = await open(fileId, teacher);
      expect(res.status).toBe(200);
      expect(typeof res.body.data.url).toBe('string');
      expect(
        (await audit(fileId)).filter((e) => e.action === 'file.download').map((e) => e.actor),
      ).toEqual([ana.person.id]);
    });

    it('is 404 for a colleague’s document, one of another Institution, and a file no document holds', async () => {
      const mine = await attached(ana);
      const colleague = await attached(bo);
      const elsewhere = await attached(cy, second);
      const loose = await readyFile();
      const teacher = await kit.actingAs(ana.person.email, TEACHER, societyId);
      expect((await open(mine.fileId, teacher)).status).toBe(200);
      for (const fileId of [colleague.fileId, elsewhere.fileId, loose]) {
        expect((await open(fileId, teacher)).status).toBe(404);
      }
      expect((await audit(colleague.fileId)).filter((e) => e.action === 'file.download')).toEqual(
        [],
      );
    });

    it('is 404 once the document is deactivated, while an admin still has the link until the sweep', async () => {
      const { fileId, documentId } = await attached(ana);
      const teacher = await kit.actingAs(ana.person.email, TEACHER, societyId);
      expect((await open(fileId, teacher)).status).toBe(200);
      expect((await api('delete', `/v1/documents/${documentId}`, owner.token)).status).toBe(200);
      expect((await open(fileId, teacher)).status).toBe(404);
      expect((await open(fileId, owner.token)).status).toBe(200);
    });

    it('is 404 for a file of another purpose, and a teacher still may not ask to upload or confirm', async () => {
      const photo = await readyFile({ purpose: 4, contentType: 'image/jpeg' }, JPEG, 'image/jpeg');
      const teacher = await kit.actingAs(ana.person.email, TEACHER, societyId);
      expect((await open(photo, teacher)).status).toBe(404);
      expect((await open(photo, owner.token)).status).toBe(200);
      const asked = await api('post', '/v1/files/uploads', teacher, {
        purpose: 6,
        institutionId: first,
        contentType: 'application/pdf',
        sizeBytes: PDF.length,
        fileName: 'mine.pdf',
      });
      expect(asked.status).toBe(403);
      expect((await api('post', `/v1/files/${photo}/confirm`, teacher)).status).toBe(403);
    });
  });

  describe('the rules the database keeps itself', () => {
    it('refuses an identity row for a record of another Society', async () => {
      const otherSociety = await kit.society(admin);
      const otherOwner = await fixtures.owner(otherSociety);
      const school = await kit.institution(otherOwner.token, categoryId);
      const stranger = await kit.staff(otherOwner.token, school, categoryId, { firstName: 'Di' });
      await expect(
        database.transaction(tenant([first]), (tx) =>
          tx
            .insertInto('staff_identities')
            .values({ staff_member_id: stranger.id, society_id: otherSociety, ...sealed(1) })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('keeps one record per number in a Society even when two rows are written straight to the table', async () => {
      await expect(
        database.transaction(tenant([first]), async (tx) => {
          for (const staff of [ana, bo]) {
            await tx
              .insertInto('staff_identities')
              .values({ staff_member_id: staff.id, society_id: societyId, ...sealed(7) })
              .execute();
          }
        }),
      ).rejects.toMatchObject({ code: '23505', constraint: 'uq_staff_identities_society_aadhaar' });
    });

    it('gives the application no right to delete an identity row', async () => {
      await identity(ana, NUMBER);
      await expect(
        database.transaction(tenant([first]), (tx) =>
          tx.deleteFrom('staff_identities').where('staff_member_id', '=', ana.id).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses a document for an Institution the session does not reach', async () => {
      const fileId = await readyFile({ institutionId: second });
      await expect(
        database.transaction(tenant([first]), (tx) =>
          tx
            .insertInto('documents')
            .values({
              society_id: societyId,
              institution_id: second,
              owner_type: 2,
              staff_member_id: cy.id,
              title: 'Letter',
              file_id: fileId,
            })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('shows a session only the documents of the Institutions it reaches', async () => {
      const mine = await attach(ana, { title: 'Letter', fileId: await readyFile() });
      const theirs = await attach(cy, {
        title: 'Letter',
        fileId: await readyFile({ institutionId: second }),
      });
      expect(await seen([first])).toEqual([mine.body.data.id]);
      expect(await seen([second])).toEqual([theirs.body.data.id]);
      expect(await seen([first, second])).toEqual(
        [mine.body.data.id, theirs.body.data.id].toSorted(),
      );
    });

    it('lets the application change only the status of a document, and never delete one', async () => {
      const made = await attach(ana, { title: 'Letter', fileId: await readyFile() });
      const id = made.body.data.id as string;
      const other = await readyFile();
      const attempts: ((tx: Tx) => Promise<unknown>)[] = [
        (tx: Tx) =>
          tx.updateTable('documents').set({ title: 'Changed' }).where('id', '=', id).execute(),
        (tx: Tx) =>
          tx.updateTable('documents').set({ file_id: other }).where('id', '=', id).execute(),
        (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) =>
          tx
            .updateTable('documents')
            .set({ institution_id: second })
            .where('id', '=', id)
            .execute(),
        (tx: Tx) => tx.deleteFrom('documents').where('id', '=', id).execute(),
      ];
      for (const attempt of attempts) {
        await expect(database.transaction(tenant([first]), attempt)).rejects.toMatchObject({
          code: '42501',
        });
      }
    });
  });
});
