import { Kysely, PostgresDialect, sql } from 'kysely';
import { DatabaseService } from '../../src/platform/database/index.js';
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
import {
  SchoolKit,
  succeeded,
  type SchoolStudent,
  type StudentPlace,
} from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;
// Synthetic numbers that pass the check digit; they belong to no one.
const NUMBER = '2345 6789 0124';
const DIGITS = '234567890124';
const OTHER = '9876 5432 1096';

const sealed = (hmacByte: number, fields: object = {}) => ({
  aadhaar_ciphertext: Buffer.from('sealed'),
  aadhaar_key_version: 1,
  aadhaar_hmac: Buffer.alloc(32, hmacByte),
  aadhaar_last4: '0124',
  ...fields,
});

/** STU-02 `identity`, STU-10 and STU-11 (API design 6.8, 10.6, 10.9): the Aadhaar and birth certificate numbers of a student. */
describe('a student’s Aadhaar and birth certificate numbers', () => {
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
  let firstPlace: StudentPlace;
  let secondPlace: StudentPlace;
  let diya: SchoolStudent;
  let ravi: SchoolStudent;

  const admit = (place: StudentPlace, fields: object = {}, token = owner.token) =>
    kit.student(token, place === secondPlace ? second : first, place, fields);
  const create = (place: StudentPlace, fields: object = {}, token = owner.token) =>
    api(
      'post',
      '/v1/students',
      token,
      kit.studentBody(place === secondPlace ? second : first, place, fields),
    );
  const identity = (student: SchoolStudent, body: unknown, token = owner.token) =>
    api('put', `/v1/students/${student.id}/identity`, token, body as object);
  const aadhaar = (student: SchoolStudent, number: unknown, token = owner.token) =>
    identity(student, { aadhaarNumber: number }, token);
  const reveal = (student: SchoolStudent, body: object = {}, token = owner.token) =>
    api('post', `/v1/students/${student.id}/identity/reveal`, token, {
      field: 'aadhaar',
      reason: 'Checking the number for the transfer certificate',
      ...body,
    });
  const read = <T>(
    work: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<T>,
  ) =>
    database.transaction(
      { personId: owner.person, roleCode: 2, societyId, institutionIds: [first, second] },
      work,
    );
  const tenantOf = (institutionIds: string[]) => ({
    personId: owner.person,
    roleCode: 2,
    societyId,
    institutionIds,
  });
  const hashOf = async (student: SchoolStudent) =>
    (
      await read(
        async (tx) =>
          (
            await sql<{
              aadhaar_hmac: Buffer;
            }>`select aadhaar_hmac from student_identities where student_id = ${student.id}`.execute(
              tx,
            )
          ).rows[0]!,
      )
    ).aadhaar_hmac;
  const asked = (
    tenant: {
      personId?: string;
      roleCode: number;
      societyId?: string;
      institutionIds?: string[];
    },
    hash: Buffer,
  ) =>
    database.transaction(tenant, async (tx) => {
      const settings = sql<{ role: string; institutions: string }>`
        select current_setting('app.role_code', true) as role,
          current_setting('app.institution_ids', true) as institutions`;
      const before = (await settings.execute(tx)).rows[0];
      const found = (
        await sql<{ found: boolean }>`
          select app_student_aadhaar_elsewhere(${first}::uuid, ${hash}) as found`.execute(tx)
      ).rows[0]!.found;
      return { found, settingsBack: (await settings.execute(tx)).rows[0], before };
    });
  const insert = (student: SchoolStudent, institutionId: string, fields: object) =>
    database.transaction(tenantOf([first]), (tx) =>
      tx
        .insertInto('student_identities')
        .values({
          student_id: student.id,
          society_id: societyId,
          institution_id: institutionId,
          ...fields,
        })
        .execute(),
    );
  const stored = (student: { id: string }) =>
    read(
      async (tx) =>
        (
          await sql<{
            aadhaar_ciphertext: Buffer | null;
            aadhaar_last4: string | null;
            birth_certificate_number: string | null;
            version: number;
            created_by: string;
            institution_id: string;
          }>`select * from student_identities where student_id = ${student.id}`.execute(tx)
        ).rows[0],
    );
  const audit = async (entityId: string) =>
    (
      await readAuditRows<{
        action: string;
        entity_type: string;
        institution_id: string | null;
        reason: string | null;
        old_values: unknown;
        new_values: unknown;
      }>(ownerDb, sql`entity_id = ${entityId}`)
    ).map(({ action, entity_type, institution_id, reason, old_values, new_values }) => ({
      action,
      entityType: entity_type,
      institutionId: institution_id,
      reason,
      before: old_values,
      after: new_values,
    }));
  const students = async () =>
    read(async (tx) => (await sql`select id from students`.execute(tx)).rows.length);

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
    firstPlace = await placeAt(first);
    secondPlace = await placeAt(second);
    diya = await admit(firstPlace);
    ravi = await admit(firstPlace);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('STU-02 with an identity', () => {
    it('seals the number with the student, answers with it masked, and keeps it in the clear nowhere', async () => {
      const res = await create(firstPlace, {
        identity: { aadhaarNumber: NUMBER, birthCertificateNumber: ' BC/2014/0042 ' },
      });
      expect(res.status).toBe(201);
      expect(res.body.meta).toBeNull();
      expect(res.body.data.identity).toEqual({
        aadhaarMasked: 'XXXX XXXX 0124',
        birthCertificateNumber: 'BC/2014/0042',
      });
      const row = (await stored(res.body.data as { id: string }))!;
      expect(row.aadhaar_last4).toBe('0124');
      expect(row.aadhaar_ciphertext).not.toBeNull();
      expect(row.created_by).toBe(owner.person);
      expect(row.institution_id).toBe(first);
      expect(await audit(res.body.data.id as string)).toContainEqual({
        action: 'identity.updated',
        entityType: 'student_identities',
        institutionId: first,
        reason: null,
        before: { aadhaarMasked: null, birthCertificateNumber: null },
        after: { aadhaarMasked: 'XXXX XXXX 0124', birthCertificateNumber: 'BC/2014/0042' },
      });
      expect(await dumpTables(ownerDb, [])).not.toContain(DIGITS);
    });

    it('shows no identity as nulls, and makes no row for a student added without one', async () => {
      expect((await create(firstPlace)).body.data.identity).toEqual({
        aadhaarMasked: null,
        birthCertificateNumber: null,
      });
      expect(await stored(diya)).toBeUndefined();
    });

    it('is 422 for a number that is not one, and adds no student', async () => {
      const before = await students();
      for (const bad of ['12', '1234 5678 9012', '0345 6789 0124', '2345 6789 0125']) {
        const res = await create(firstPlace, { identity: { aadhaarNumber: bad } });
        expect([res.status, res.body.code]).toEqual([422, 'INVALID_AADHAAR']);
      }
      expect(await students()).toBe(before);
    });

    it('is 409 when an active student of the Institution holds the number, and adds no student and no parent login', async () => {
      await aadhaar(diya, NUMBER);
      const before = await students();
      const body = kit.studentBody(first, firstPlace, { identity: { aadhaarNumber: DIGITS } });
      const res = await api('post', '/v1/students', owner.token, body);
      expect([res.status, res.body.code]).toEqual([409, 'AADHAAR_DUPLICATE_IN_INSTITUTION']);
      expect(JSON.stringify(res.body)).not.toContain(diya.id);
      expect(await students()).toBe(before);
      const logins = await sql<{ n: string }>`
        select count(*) as n from users where email = ${body.guardians[0]!.email}`.execute(ownerDb);
      expect(Number(logins.rows[0]!.n)).toBe(0);
    });

    it('warns, and still adds the student, when another Institution of the Society holds the number', async () => {
      const elsewhere = await admit(secondPlace, { identity: { aadhaarNumber: NUMBER } });
      expect(elsewhere.id).toBeDefined();
      const res = await create(firstPlace, { identity: { aadhaarNumber: NUMBER } });
      expect(res.status).toBe(201);
      expect(res.body.meta).toEqual({ warnings: ['AADHAAR_EXISTS_IN_SOCIETY'] });
      expect(res.body.data.identity).toMatchObject({ aadhaarMasked: 'XXXX XXXX 0124' });
    });

    it('lists both warnings when the section is over capacity too', async () => {
      succeeded(
        await api('patch', `/v1/sections/${firstPlace.sectionId}`, owner.token, {
          capacity: 2,
          version: 1,
        }),
        200,
        'capacity',
      );
      await admit(secondPlace, { identity: { aadhaarNumber: NUMBER } });
      const res = await create(firstPlace, { identity: { aadhaarNumber: NUMBER } });
      expect(res.status).toBe(201);
      expect(res.body.meta).toEqual({
        warnings: ['SECTION_OVER_CAPACITY', 'AADHAAR_EXISTS_IN_SOCIETY'],
      });
    });

    it('refuses a bank field and a number as a JSON number', async () => {
      for (const identityBody of [{ bankAccount: '1' }, { aadhaarNumber: 234567890124 }]) {
        expect((await create(firstPlace, { identity: identityBody })).status).toBe(400);
      }
    });
  });

  describe('STU-03 and the other answers about a student', () => {
    it('show the identity masked to an admin, and no teacher’s view has it', async () => {
      await identity(diya, { aadhaarNumber: NUMBER, birthCertificateNumber: 'BC-1' });
      const expected = { aadhaarMasked: 'XXXX XXXX 0124', birthCertificateNumber: 'BC-1' };
      const profile = await api('get', `/v1/students/${diya.id}`, owner.token);
      expect(profile.body.data.identity).toEqual(expected);
      expect(JSON.stringify(profile.body)).not.toContain(DIGITS);
      const edited = await api('patch', `/v1/students/${diya.id}`, owner.token, {
        version: diya.version,
        nationality: 'Indian',
      });
      expect(edited.body.data.identity).toEqual(expected);
      const moved = await api('patch', `/v1/students/${diya.id}/placement`, owner.token, {
        rollNumber: 'R99',
      });
      expect(moved.body.data.identity).toEqual(expected);
      const list = await api('get', '/v1/students', owner.token);
      expect(JSON.stringify(list.body)).not.toContain('identity');
    });
  });

  describe('STU-10 set the numbers', () => {
    it('seals the number, answers with it masked, audits it without the number and keeps no clear copy', async () => {
      const res = await identity(diya, { aadhaarNumber: NUMBER, birthCertificateNumber: 'BC-1' });
      expect(res.status).toBe(200);
      expect(res.body.meta).toBeNull();
      expect(res.body.data).toEqual({
        aadhaarMasked: 'XXXX XXXX 0124',
        birthCertificateNumber: 'BC-1',
      });
      const row = (await stored(diya))!;
      expect(row.aadhaar_last4).toBe('0124');
      expect(Buffer.from(row.aadhaar_ciphertext!).toString()).not.toContain(DIGITS);
      expect(await audit(diya.id)).toContainEqual(
        expect.objectContaining({
          action: 'identity.updated',
          entityType: 'student_identities',
          institutionId: first,
          before: { aadhaarMasked: null, birthCertificateNumber: null },
          after: { aadhaarMasked: 'XXXX XXXX 0124', birthCertificateNumber: 'BC-1' },
        }),
      );
      expect(await dumpTables(ownerDb, [])).not.toContain(DIGITS);
    });

    it('writes nothing for the same numbers again, however the digits are written', async () => {
      await identity(diya, { aadhaarNumber: NUMBER, birthCertificateNumber: 'BC-1' });
      const version = (await stored(diya))!.version;
      expect((await aadhaar(diya, DIGITS)).body.data.aadhaarMasked).toBe('XXXX XXXX 0124');
      expect((await aadhaar(diya, '2345-6789-0124')).status).toBe(200);
      expect((await identity(diya, {})).body.data).toEqual({
        aadhaarMasked: 'XXXX XXXX 0124',
        birthCertificateNumber: 'BC-1',
      });
      expect((await stored(diya))!.version).toBe(version);
      expect((await audit(diya.id)).filter((e) => e.action.startsWith('identity.'))).toHaveLength(
        1,
      );
    });

    it('sets one number and leaves the other, and replaces a number', async () => {
      await identity(diya, { birthCertificateNumber: 'BC-1' });
      expect((await aadhaar(diya, NUMBER)).body.data).toEqual({
        aadhaarMasked: 'XXXX XXXX 0124',
        birthCertificateNumber: 'BC-1',
      });
      expect((await aadhaar(diya, OTHER)).body.data.aadhaarMasked).toBe('XXXX XXXX 1096');
      expect((await reveal(diya)).body.data.value).toBe('987654321096');
    });

    it('clears a number with null, keeps the row, and reveals nothing after', async () => {
      await identity(diya, { aadhaarNumber: NUMBER, birthCertificateNumber: 'BC-1' });
      expect((await aadhaar(diya, null)).body.data).toEqual({
        aadhaarMasked: null,
        birthCertificateNumber: 'BC-1',
      });
      expect((await stored(diya))!.aadhaar_ciphertext).toBeNull();
      const none = await reveal(diya);
      expect([none.status, none.body.code]).toEqual([404, 'NOT_SET']);
      await identity(diya, { birthCertificateNumber: null });
      expect(
        (await audit(diya.id)).filter((e) => e.action.startsWith('identity.')).map((e) => e.action),
      ).toEqual(['identity.updated', 'identity.updated', 'identity.cleared']);
      expect((await aadhaar(diya, NUMBER)).body.data.aadhaarMasked).toBe('XXXX XXXX 0124');
    });

    it('answers 200 with nothing set when there was nothing to clear, and makes no row', async () => {
      expect(
        (await identity(diya, { aadhaarNumber: null, birthCertificateNumber: null })).body.data,
      ).toEqual({
        aadhaarMasked: null,
        birthCertificateNumber: null,
      });
      expect(await stored(diya)).toBeUndefined();
    });

    it.each([
      ['a number that is too short', { aadhaarNumber: '12' }],
      ['a first digit of 1', { aadhaarNumber: '1234 5678 9012' }],
      ['a wrong check digit', { aadhaarNumber: '2345 6789 0125' }],
      ['letters', { aadhaarNumber: 'abcd efgh ijkl' }],
    ])('is 422 INVALID_AADHAAR for %s, and writes nothing', async (_name, body) => {
      const res = await identity(diya, body);
      expect([res.status, res.body.code]).toEqual([422, 'INVALID_AADHAAR']);
      expect(await stored(diya)).toBeUndefined();
    });

    it('is 400 for a JSON number, a blank certificate number, a bank field', async () => {
      for (const body of [
        { aadhaarNumber: 234567890124 },
        { birthCertificateNumber: '   ' },
        { birthCertificateNumber: 'x'.repeat(51) },
        { bankAccount: '1' },
      ]) {
        expect((await identity(diya, body)).status).toBe(400);
      }
    });

    it('keeps one record per number in the Institution, without saying whose it is', async () => {
      await aadhaar(diya, NUMBER);
      const res = await aadhaar(ravi, DIGITS);
      expect([res.status, res.body.code]).toEqual([409, 'AADHAAR_DUPLICATE_IN_INSTITUTION']);
      expect(JSON.stringify(res.body)).not.toContain(diya.id);
      expect(JSON.stringify(res.body)).not.toContain('Diya');
      expect(await stored(ravi)).toBeUndefined();
    });

    it('lets two requests claim one number: one wins, the other is 409', async () => {
      const [a, b] = await Promise.all([aadhaar(diya, NUMBER), aadhaar(ravi, NUMBER)]);
      expect([a.status, b.status].toSorted()).toEqual([200, 409]);
      expect([a.body.code, b.body.code]).toContain('AADHAAR_DUPLICATE_IN_INSTITUTION');
    });

    it('takes the number from a deactivated student, who then holds none, audited on that record', async () => {
      await aadhaar(diya, NUMBER);
      expect((await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token)).status).toBe(
        200,
      );
      expect((await aadhaar(ravi, NUMBER)).body.data.aadhaarMasked).toBe('XXXX XXXX 0124');
      expect((await stored(diya))!.aadhaar_last4).toBeNull();
      const gone = await reveal(diya);
      expect([gone.status, gone.body.code]).toEqual([404, 'NOT_SET']);
      expect((await reveal(ravi)).body.data.value).toBe(DIGITS);
      expect(await audit(diya.id)).toContainEqual(
        expect.objectContaining({
          action: 'identity.released',
          entityType: 'student_identities',
          institutionId: first,
          before: { aadhaarMasked: 'XXXX XXXX 0124' },
          after: { aadhaarMasked: null, takenBy: ravi.id },
        }),
      );
    });

    it('never warns for its own Institution: a schoolmate’s released number, or the same number sent again', async () => {
      await aadhaar(diya, NUMBER);
      await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token);
      const taken = await aadhaar(ravi, NUMBER);
      expect([taken.status, taken.body.meta]).toEqual([200, null]);
      expect((await aadhaar(ravi, NUMBER)).body.meta).toBeNull();
    });

    it('warns when another Institution of the Society holds the number, to an Admin who does not reach it, and writes the number', async () => {
      await admit(secondPlace, { identity: { aadhaarNumber: NUMBER } });
      const res = await aadhaar(diya, NUMBER, institutionAdmin.token);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ warnings: ['AADHAAR_EXISTS_IN_SOCIETY'] });
      expect(res.body.data.aadhaarMasked).toBe('XXXX XXXX 0124');
      expect(JSON.stringify(res.body)).not.toContain(second);
      // The warning follows the number, so the same number sent again warns again and writes nothing.
      const again = await aadhaar(diya, NUMBER);
      expect(again.body.meta).toEqual({ warnings: ['AADHAAR_EXISTS_IN_SOCIETY'] });
      // A number held by nobody else does not warn.
      expect((await aadhaar(diya, OTHER)).body.meta).toBeNull();
    });

    it('warns for a student who left the other Institution too, and not for another Society’s number', async () => {
      const elsewhere = await admit(secondPlace, { identity: { aadhaarNumber: NUMBER } });
      await api('delete', `/v1/students/${elsewhere.id}?reason=1`, owner.token);
      expect((await aadhaar(diya, NUMBER)).body.meta).toEqual({
        warnings: ['AADHAAR_EXISTS_IN_SOCIETY'],
      });
      const otherSociety = await kit.society(admin);
      const otherOwner = await fixtures.owner(otherSociety);
      const school = await kit.institution(otherOwner.token, categoryId);
      const classes = await kit.masters(admin, 'predefined-classes');
      const sectionCodes = await kit.masters(admin, 'predefined-sections');
      const strangerPlace: StudentPlace = {
        academicYearId: await kit.year(otherOwner.token, school),
        classId: await kit.klass(
          otherOwner.token,
          school,
          classes.find((c) => c.code === 'C09')!.id,
        ),
        sectionId: '',
      };
      strangerPlace.sectionId = await kit.section(
        otherOwner.token,
        strangerPlace.classId,
        sectionCodes.find((s) => s.code === 'A')!.id,
      );
      const stranger = await kit.student(otherOwner.token, school, strangerPlace, {
        identity: { aadhaarNumber: OTHER },
      });
      expect(stranger.id).toBeDefined();
      const res = await aadhaar(diya, OTHER);
      expect([res.status, res.body.meta]).toEqual([200, null]);
    });

    it('is for the admins of the child’s Institution; a teacher, a Super Admin and strangers are refused', async () => {
      expect((await aadhaar(diya, NUMBER, institutionAdmin.token)).status).toBe(200);
      const abroad = await admit(secondPlace);
      expect((await aadhaar(abroad, NUMBER, institutionAdmin.token)).status).toBe(404);
      expect((await aadhaar(diya, NUMBER, admin)).status).toBe(403);
      const staff = await kit.staff(owner.token, first, categoryId, { firstName: 'Meera' });
      const teacher = await kit.actingAs(staff.person.email, TEACHER, societyId);
      expect((await aadhaar(diya, NUMBER, teacher)).status).toBe(403);
      expect((await reveal(diya, {}, teacher)).status).toBe(403);
      const otherOwner = await fixtures.owner(await kit.society(admin));
      expect((await aadhaar(diya, NUMBER, otherOwner.token)).status).toBe(404);
      expect(
        (await api('put', '/v1/students/not-a-uuid/identity', owner.token, { aadhaarNumber: null }))
          .status,
      ).toBe(404);
    });

    it('is 404 for a deactivated student', async () => {
      await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token);
      expect((await aadhaar(diya, NUMBER)).status).toBe(404);
    });
  });

  describe('STU-11 reveal the Aadhaar number', () => {
    it('gives the number once the entry with the reason is written, and never logs it', async () => {
      await aadhaar(diya, NUMBER);
      const res = await reveal(diya);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ field: 'aadhaar', value: DIGITS });
      expect(Number.isNaN(Date.parse(res.body.data.revealedAt as string))).toBe(false);
      expect(res.headers['cache-control']).toBe('no-store');
      expect((await audit(diya.id)).filter((e) => e.action === 'identity.reveal')).toEqual([
        expect.objectContaining({
          entityType: 'student_identities',
          institutionId: first,
          reason: 'Checking the number for the transfer certificate',
        }),
      ]);
      expect(await dumpTables(ownerDb, [])).not.toContain(DIGITS);
    });

    it('refuses what it cannot reveal: no number, the birth certificate, a short or missing reason', async () => {
      const none = await reveal(diya);
      expect([none.status, none.body.code]).toEqual([404, 'NOT_SET']);
      await identity(diya, { birthCertificateNumber: 'BC-1' });
      expect((await reveal(diya)).body.code).toBe('NOT_SET');
      await aadhaar(diya, NUMBER);
      expect((await reveal(diya, { field: 'birthCertificateNumber' })).status).toBe(400);
      const short = await reveal(diya, { reason: 'because' });
      expect(short.status).toBe(400);
      expect(short.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'reason', code: 'TOO_SHORT' })]),
      );
      expect((await reveal(diya, { reason: 'x'.repeat(501) })).status).toBe(400);
      expect((await reveal(diya, { reason: undefined })).status).toBe(400);
      expect((await audit(diya.id)).filter((e) => e.action === 'identity.reveal')).toEqual([]);
    });

    it('shares the ten a day with the staff reveal: an admin is stopped at ten with 429 and a wait', async () => {
      await aadhaar(diya, NUMBER);
      for (let i = 0; i < 10; i += 1) expect((await reveal(diya)).status).toBe(200);
      const eleventh = await reveal(diya);
      expect([eleventh.status, eleventh.body.code]).toEqual([429, 'REVEAL_LIMIT']);
      expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('is for the admins of the child’s Institution, and works for a deactivated student', async () => {
      await aadhaar(diya, NUMBER);
      expect((await reveal(diya, {}, admin)).status).toBe(403);
      const abroad = await admit(secondPlace);
      expect((await reveal(abroad, {}, institutionAdmin.token)).status).toBe(404);
      expect((await reveal(diya, {}, institutionAdmin.token)).body.data.value).toBe(DIGITS);
      await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token);
      expect((await reveal(diya)).body.data.value).toBe(DIGITS);
    });
  });

  describe('the rules the database keeps itself', () => {
    it('keeps one record per number in an Institution even when two rows are written straight to the table', async () => {
      await expect(
        database.transaction(tenantOf([first]), async (tx) => {
          for (const student of [diya, ravi]) {
            await tx
              .insertInto('student_identities')
              .values({
                student_id: student.id,
                society_id: societyId,
                institution_id: first,
                ...sealed(7),
              })
              .execute();
          }
        }),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'uq_student_identities_institution_aadhaar',
      });
    });

    it('refuses an identity row for a student of an Institution the session does not reach', async () => {
      const abroad = await admit(secondPlace);
      await expect(insert(abroad, second, sealed(1))).rejects.toThrow(/row-level security/);
    });

    it('refuses to move an identity row to another Institution', async () => {
      await aadhaar(diya, NUMBER);
      await expect(
        database.transaction(tenantOf([first]), (tx) =>
          tx.updateTable('student_identities').set({ institution_id: second }).execute(),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('gives the application no right to delete an identity row', async () => {
      await aadhaar(diya, NUMBER);
      await expect(
        database.transaction(tenantOf([first]), (tx) =>
          tx.deleteFrom('student_identities').where('student_id', '=', diya.id).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it.each([
      [
        'an Aadhaar number with a part missing',
        { aadhaar_last4: null },
        'ck_student_identities_aadhaar_complete',
      ],
      [
        'a hash that is not 32 bytes',
        { aadhaar_hmac: Buffer.alloc(8, 1) },
        'ck_student_identities_aadhaar_hmac',
      ],
      [
        'last four digits that are not digits',
        { aadhaar_last4: 'abcd' },
        'ck_student_identities_aadhaar_last4',
      ],
      [
        'a blank birth certificate number',
        { birth_certificate_number: '  ' },
        'ck_student_identities_birth_certificate',
      ],
    ])('refuses %s', async (_name, fields, constraint) => {
      await expect(insert(diya, first, sealed(1, fields))).rejects.toMatchObject({
        code: '23514',
        constraint,
      });
    });
  });

  describe('app_student_aadhaar_elsewhere', () => {
    it('answers for the caller’s own Society only, and puts the caller’s settings back', async () => {
      const held = await admit(secondPlace, { identity: { aadhaarNumber: NUMBER } });
      const hash = await hashOf(held);
      const mine = { personId: owner.person, roleCode: 2, societyId, institutionIds: [first] };
      const answer = await asked(mine, hash);
      expect(answer.found).toBe(true);
      expect(answer.settingsBack).toEqual(answer.before);

      const otherSociety = await kit.society(admin);
      const abroad = await asked(
        { personId: owner.person, roleCode: 2, societyId: otherSociety, institutionIds: [] },
        hash,
      );
      expect(abroad.found).toBe(false);
      expect(abroad.settingsBack).toEqual(abroad.before);
      const nobody = await asked({ roleCode: 2 }, hash);
      expect(nobody.found).toBe(false);
      expect(nobody.settingsBack).toEqual(nobody.before);
    });
  });
});
