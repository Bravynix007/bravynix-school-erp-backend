import { Kysely, PostgresDialect, sql } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { FilesRepository } from '../../src/platform/files/files.repository.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import * as blocks from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, type SchoolStudent, type StudentPlace } from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

const guardian = (fields: object = {}) => ({
  firstName: 'Ravi',
  lastName: 'Shetty',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  email: `${newId()}@parent.test`,
  isPrimary: true,
  isEmergencyContact: false,
  ...fields,
});
const namesOf = (res: { body: { data: unknown } }) =>
  (res.body.data as unknown as { firstName: string }[]).map((row) => row.firstName);

interface StudentData extends SchoolStudent {
  lastName: string | null;
  gender: number | null;
  dateOfBirth: string | null;
  contactEmail: string | null;
  mobile: { countryCode: string; number: string } | null;
  address: Record<string, string | null>;
  photoFileId: string | null;
  admissionDate: string | null;
  status: number;
  createdBy: { id: string };
  placement: {
    enrolmentId: string;
    academicYearId: string;
    classId: string;
    sectionId: string;
    rollNumber: string;
    enrolledDate: string;
    startDate: string;
  };
}

/** STU-01 to STU-03 and the student tables (API design 9.6, 10.6; DDD 9.6). */
describe('students: add, read and list', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;

  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let societyA: string;
  let first: string;
  let second: string;
  let categoryId: string;
  let year: string;
  let classNine: string;
  let sectionA: string;
  let sectionB: string;
  let classTen: string;
  let sectionTen: string;
  let place: { countryId: string; stateId: string; cityId: string };

  const masters = (type: string) => kit.masters(admin, type);
  const where = (): StudentPlace => ({
    academicYearId: year,
    classId: classNine,
    sectionId: sectionA,
  });
  const body = (fields: object = {}, at: StudentPlace = where()) =>
    kit.studentBody(first, at, fields);
  const add = (fields: object = {}, token = owner.token, at: StudentPlace = where()) =>
    api('post', '/v1/students', token, body(fields, at));
  const added = (fields: object = {}, at: StudentPlace = where()) =>
    kit.student(owner.token, first, at, fields) as Promise<StudentData>;
  const roll = (rollNumber: string, at: StudentPlace = where()) => ({
    enrolment: { ...at, rollNumber },
  });
  const tenant = (institutionIds = [first]) => ({
    personId: owner.person,
    roleCode: 2,
    societyId: societyA,
    institutionIds,
  });
  const refused = (statement: ReturnType<typeof sql>) =>
    database.transaction(tenant(), (tx) => statement.execute(tx));
  const deactivateRow = (id: string) =>
    refused(sql`update students set status = 0 where id = ${id}`);
  const audit = (id: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      institution_id: string;
      entity_type: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${id}`);
  const usersWith = async (address: string) =>
    (
      await sql<{ id: string; account_status: number }>`
      select id, account_status from users where email = ${address}`.execute(ownerDb)
    ).rows;
  const readyPhoto = async (institutionId = first, purpose = 3, status = 2) => {
    const id = newId();
    await database.transaction({ societyId: societyA, institutionIds: [institutionId] }, (tx) =>
      new FilesRepository().insert(tx, {
        id,
        society_id: societyA,
        institution_id: institutionId,
        created_by: owner.person,
        storage_bucket: 1,
        object_key: `${societyA}/${institutionId}/${purpose}/${id}`,
        purpose,
        content_type: 'image/jpeg',
        size_bytes: 100,
        file_status: status,
      }),
    );
    return id;
  };
  const list = (query: string, token = owner.token) => api('get', `/v1/students${query}`, token);
  const class9 = async () => {
    const zara = await added({
      firstName: 'Zara',
      lastName: 'Khan',
      admissionNo: 'ADM-300',
      ...roll('3'),
    });
    const asha = await added({
      firstName: 'Asha',
      lastName: 'Bose',
      admissionNo: 'ADM-100',
      ...roll('10'),
    });
    const meera = await added({
      firstName: 'Meera',
      lastName: null,
      ...roll('1', { ...where(), sectionId: sectionB }),
    });
    const dev = await added({
      firstName: 'Dev',
      ...roll('1', { academicYearId: year, classId: classTen, sectionId: sectionTen }),
    });
    return { zara, asha, meera, dev };
  };
  const blocksOf = async (person: string, society = societyA) =>
    (
      await sql<{ section: number; institution_id: string | null }>`
        select * from app_active_blocks(${society}, ${person})`.execute(ownerDb)
    ).rows;

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
    const { rows: places } = await sql<{ country_id: string; state_id: string; city_id: string }>`
      select s.country_id, c.state_id, c.id as city_id from cities c join states s on s.id = c.state_id
      where c.status = 1 and s.status = 1 limit 1
    `.execute(ownerDb);
    place = {
      countryId: places[0]!.country_id,
      stateId: places[0]!.state_id,
      cityId: places[0]!.city_id,
    };
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    const categories = await masters('class-categories');
    categoryId = categories.find((c) => c.code === 'HIGH_SCHOOL')!.id;
    const classes = await masters('predefined-classes');
    const sectionCodes = await masters('predefined-sections');
    societyA = await kit.society(admin);
    owner = await fixtures.owner(societyA);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
    otherOwner = await fixtures.owner(await kit.society(admin));
    year = await kit.year(owner.token, first);
    classNine = await kit.klass(owner.token, first, classes.find((c) => c.code === 'C09')!.id);
    classTen = await kit.klass(owner.token, first, classes.find((c) => c.code === 'C10')!.id);
    sectionA = await kit.section(
      owner.token,
      classNine,
      sectionCodes.find((s) => s.code === 'A')!.id,
    );
    sectionB = await kit.section(
      owner.token,
      classNine,
      sectionCodes.find((s) => s.code === 'B')!.id,
    );
    sectionTen = await kit.section(
      owner.token,
      classTen,
      sectionCodes.find((s) => s.code === 'A')!.id,
    );
  });

  afterEach(async () => {
    await blocks.clearBlocks(ownerDb);
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('STU-02 add', () => {
    it('adds the student with the placement and the guardians, a Pending login for a new email, and the welcome after the commit', async () => {
      const parent = guardian({
        alternatePhone: '9845012346',
        occupation: 'Engineer',
        isEmergencyContact: true,
      });
      const fields = {
        lastName: 'Shetty',
        gender: 2,
        dateOfBirth: '2014-03-09',
        bloodGroup: 'O+',
        nationality: 'Indian',
        admissionNo: 'GVS-2026-0412',
        admissionDate: '2026-06-01',
        contactEmail: 'Diya.Own@Example.com',
        alternateNumber: '9876501235',
        address: { line1: '4 Temple Street', ...place, pincode: '560001' },
        guardians: [parent],
      };
      const res = await add(fields);
      expect(res.status).toBe(201);
      expect(res.body.code).toBe('CREATED');
      expect(res.body.meta).toBeNull();
      const student = res.body.data as unknown as StudentData;
      expect(student).toMatchObject({
        status: 1,
        version: 1,
        institutionId: first,
        admissionNo: 'GVS-2026-0412',
        firstName: 'Diya',
        lastName: 'Shetty',
        gender: 2,
        dateOfBirth: '2014-03-09',
        admissionDate: '2026-06-01',
        contactEmail: 'diya.own@example.com',
        mobile: { countryCode: '91', number: '9876501234' },
        address: { line1: '4 Temple Street', ...place, pincode: '560001' },
        placement: {
          academicYearId: year,
          classId: classNine,
          sectionId: sectionA,
          enrolledDate: '2026-06-01',
          startDate: '2026-06-01',
        },
        createdBy: { id: owner.person },
      });
      expect(student.guardians).toEqual([
        expect.objectContaining({
          firstName: 'Ravi',
          relation: 1,
          phone: { countryCode: '91', number: '9845012345' },
          alternatePhone: '9845012346',
          email: parent.email,
          occupation: 'Engineer',
          isPrimary: true,
          isEmergencyContact: true,
          hasLogin: true,
        }),
      ]);
      // A new email is a Pending account, and the welcome names the role and the Society.
      expect((await usersWith(parent.email)).map((u) => u.account_status)).toEqual([3]);
      expect(t.email.latest(parent.email, 'welcome')?.variables).toMatchObject({
        role: 'Parent',
        society: 'Sunrise Trust',
      });
      const read = await api('get', `/v1/students/${student.id}`, owner.token);
      expect(read.body.data).toMatchObject({ id: student.id, firstName: 'Diya', version: 1 });
    });

    it('starts the placement today when there is no admission date, and keeps a guardian without an email loginless', async () => {
      const res = await add({
        guardians: [guardian({ email: null }), guardian({ isPrimary: false, email: undefined })],
      });
      expect(res.status).toBe(201);
      const student = res.body.data as unknown as StudentData;
      expect(student.placement.startDate).toBe(t.clock.todayIst());
      expect(student.admissionDate).toBeNull();
      expect(student.guardians.map((g) => [g.email, g.hasLogin])).toEqual([
        [null, false],
        [null, false],
      ]);
    });

    it('links the person an email already belongs to, so two children share one parent login', async () => {
      const parent = guardian();
      const a = await added({ guardians: [parent], ...roll('1') });
      const b = await added({
        firstName: 'Kabir',
        guardians: [{ ...parent, email: parent.email.toUpperCase() }],
        ...roll('2'),
      });
      expect(a.guardians[0]?.email).toBe(parent.email);
      expect(b.guardians[0]?.email).toBe(parent.email);
      expect(await usersWith(parent.email)).toHaveLength(1);
      const linked = await database.transaction(tenant(), (tx) =>
        tx
          .selectFrom('student_guardians')
          .select('user_id')
          .where('student_id', 'in', [a.id, b.id])
          .execute(),
      );
      expect(new Set(linked.map((row) => row.user_id)).size).toBe(1);
    });

    it('refuses a second active student with the same Admission ID in the Institution, in any letter case, but not in another Institution or once the first is gone', async () => {
      await added({ admissionNo: 'GVS-1', ...roll('1') });
      const taken = await add({ admissionNo: 'gvs-1', ...roll('2') });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('ADMISSION_NO_TAKEN');
      // Another Institution's students have their own numbering.
      const otherClasses = await masters('predefined-classes');
      const otherYear = await kit.year(owner.token, second);
      const otherClass = await kit.klass(
        owner.token,
        second,
        otherClasses.find((c) => c.code === 'C09')!.id,
      );
      const sectionCodes = await masters('predefined-sections');
      const otherSection = await kit.section(
        owner.token,
        otherClass,
        sectionCodes.find((s) => s.code === 'A')!.id,
      );
      const elsewhere = await api(
        'post',
        '/v1/students',
        owner.token,
        kit.studentBody(
          second,
          { academicYearId: otherYear, classId: otherClass, sectionId: otherSection },
          { admissionNo: 'GVS-1' },
        ),
      );
      expect(elsewhere.status).toBe(201);
    });

    it('refuses a roll number that another current student of the section has, in any letter case, but not in another section', async () => {
      await added(roll('A1'));
      const taken = await add(roll('a1'));
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('ROLL_NUMBER_TAKEN');
      const other = await add(roll('A1', { ...where(), sectionId: sectionB }));
      expect(other.status).toBe(201);
    });

    it('does all of it or none: a refused student leaves no account, no record and no mail', async () => {
      await added(roll('9'));
      const parent = guardian();
      const before = await sql<{ n: number }>`select count(*)::int as n from students`.execute(
        ownerDb,
      );
      const duplicate = await add({ guardians: [parent], ...roll('9') });
      expect(duplicate.status).toBe(409);
      expect(await usersWith(parent.email)).toEqual([]);
      expect(t.email.latest(parent.email, 'welcome')).toBeUndefined();
      const after = await sql<{ n: number }>`select count(*)::int as n from students`.execute(
        ownerDb,
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    });

    it('is 422 when the section is not in the class, is deactivated, or the year is not active', async () => {
      const wrongClass = await add({}, owner.token, { ...where(), classId: classTen });
      expect([wrongClass.status, wrongClass.body.code]).toEqual([422, 'SECTION_NOT_IN_CLASS']);

      expect((await api('delete', `/v1/sections/${sectionB}`, owner.token)).status).toBe(200);
      const closed = await add({}, owner.token, { ...where(), sectionId: sectionB });
      expect([closed.status, closed.body.code]).toEqual([422, 'INACTIVE_SECTION']);

      const spare = await kit.year(owner.token, first, {
        name: '2027-2028',
        startDate: '2027-06-01',
        endDate: '2028-03-31',
      });
      expect((await api('delete', `/v1/academic-years/${spare}`, owner.token)).status).toBe(200);
      const old = await add({}, owner.token, { ...where(), academicYearId: spare });
      expect([old.status, old.body.code]).toEqual([422, 'YEAR_NOT_ACTIVE']);
    });

    it('is 404 for a year or section that is not this Institution’s or does not exist', async () => {
      const otherYear = await kit.year(owner.token, second);
      expect((await add({}, owner.token, { ...where(), academicYearId: otherYear })).status).toBe(
        404,
      );
      expect((await add({}, owner.token, { ...where(), academicYearId: missing })).status).toBe(
        404,
      );
      expect((await add({}, owner.token, { ...where(), sectionId: missing })).status).toBe(404);
    });

    it('warns, and still adds, when the section is over its capacity', async () => {
      const set = await api('patch', `/v1/sections/${sectionA}`, owner.token, {
        version: 1,
        capacity: 1,
      });
      expect(set.status).toBe(200);
      const first1 = await add(roll('1'));
      expect(first1.status).toBe(201);
      expect(first1.body.meta).toBeNull();
      const over = await add(roll('2'));
      expect(over.status).toBe(201);
      expect(over.body.meta).toEqual({ warnings: ['SECTION_OVER_CAPACITY'] });
    });

    it('starts the placement inside the year: an admission date before it starts the year, one after it is refused', async () => {
      const early = await add({ admissionDate: '2020-01-01' });
      expect(early.status).toBe(201);
      expect(early.body.data).toMatchObject({
        admissionDate: '2020-01-01',
        placement: { enrolledDate: '2026-06-01', startDate: '2026-06-01' },
      });
      const late = await add({ admissionDate: '2027-09-01', ...roll('2') });
      expect([late.status, late.body.errors?.[0]?.field, late.body.errors?.[0]?.code]).toEqual([
        400,
        'admissionDate',
        'INVALID_VALUE',
      ]);
    });

    it('wants exactly one primary guardian, and one login for each email', async () => {
      for (const guardians of [[guardian({ isPrimary: false })], [guardian(), guardian()]]) {
        const res = await add({ guardians });
        expect([res.status, res.body.code]).toEqual([422, 'PRIMARY_GUARDIAN_REQUIRED']);
      }
      const same = guardian();
      const twice = await add({
        guardians: [same, guardian({ isPrimary: false, email: same.email.toUpperCase() })],
      });
      expect(twice.status).toBe(400);
      expect(twice.body.errors).toEqual([
        expect.objectContaining({ field: 'guardians[1].email', code: 'INVALID_VALUE' }),
      ]);
    });

    it('refuses what the body may not say: no guardian, six guardians, blank names, future birth, and the fields of later slices', async () => {
      const six = Array.from({ length: 6 }, (_, i) => guardian({ isPrimary: i === 0 }));
      const cases: [object, string][] = [
        [{ guardians: [] }, 'guardians'],
        [{ guardians: six }, 'guardians'],
        [{ firstName: '   ' }, 'firstName'],
        [{ enrolment: { ...where(), rollNumber: '   ' } }, 'enrolment.rollNumber'],
        [{ enrolment: { ...where(), rollNumber: 'x'.repeat(21) } }, 'enrolment.rollNumber'],
        [{ dateOfBirth: '2999-01-01' }, 'dateOfBirth'],
        [{ dateOfBirth: '2014-03-09', admissionDate: '2010-01-01' }, 'admissionDate'],
        [{ gender: 4 }, 'gender'],
        [{ bloodGroup: 'C+' }, 'bloodGroup'],
        [{ identity: { aadhaarNumber: '234567890124' } }, 'identity'],
        [{ fromEnquiryId: newId() }, 'fromEnquiryId'],
        [{ mobile: undefined }, 'mobile'],
      ];
      for (const [fields, field] of cases) {
        const res = await add(fields);
        expect([res.status, res.body.errors?.[0]?.field]).toEqual([400, field]);
      }
    });

    it('takes a Ready photo of purpose 3 of the Institution once, and refuses any other', async () => {
      const photo = await readyPhoto();
      const ok = await add({ photoFileId: photo });
      expect(ok.status).toBe(201);
      expect((ok.body.data as unknown as StudentData).photoFileId).toBe(photo);
      const again = await add({ photoFileId: photo });
      expect([again.status, again.body.errors?.[0]?.field]).toEqual([400, 'photoFileId']);
      // A file of another purpose, or not Ready, is refused on the field; one the Institution cannot see is not found.
      for (const wrong of [await readyPhoto(first, 4), await readyPhoto(first, 3, 1)]) {
        const res = await add({ photoFileId: wrong });
        expect([res.status, res.body.errors?.[0]?.field]).toEqual([400, 'photoFileId']);
      }
      for (const unseen of [await readyPhoto(second), missing]) {
        expect((await add({ photoFileId: unseen })).status).toBe(404);
      }
    });

    it('checks the place against the platform masters', async () => {
      const res = await add({ address: { stateId: place.stateId } });
      expect(res.status).toBe(400);
      expect(res.body.errors?.[0]?.field).toContain('address');
    });

    it('writes one audit entry for the Institution, with no email, address line or whole number', async () => {
      const student = await added({
        admissionNo: 'GVS-9',
        alternateNumber: '9876501235',
        contactEmail: 'diya.own@example.com',
        address: { line1: '4 Temple Street' },
        guardians: [guardian({ alternatePhone: '9845012346' })],
      });
      const entries = (await audit(student.id)).filter((e) => e.action === 'student.created');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor_user_id: owner.person,
        institution_id: first,
        entity_type: 'student',
        old_values: null,
      });
      expect(entries[0]?.new_values).toMatchObject({
        admissionNo: 'GVS-9',
        firstName: 'Diya',
        mobile: '******1234',
        alternateNumber: '******1235',
        addressLines: 1,
        classId: classNine,
        sectionId: sectionA,
        guardians: [
          expect.objectContaining({ firstName: 'Ravi', phone: '******2345', hasLogin: true }),
        ],
      });
      const text = JSON.stringify(entries[0]?.new_values);
      for (const secret of [
        'diya.own@example.com',
        '4 Temple Street',
        '9876501234',
        '9845012345',
        '@parent.test',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('is for Owners and Admins of the Institution: an Admin of another Institution gets 404, a Teacher 403', async () => {
      expect((await add({}, institutionAdmin.token)).status).toBe(201);
      const elsewhere = await fixtures.institutionAdmin(societyA, [second]);
      expect((await add({}, elsewhere.token)).status).toBe(404);
      expect((await add({}, otherOwner.token)).status).toBe(404);
      const teacher = await kit.staff(owner.token, first, categoryId);
      const token = await kit.actingAs(teacher.person.email, 4, societyA);
      expect((await add({}, token)).status).toBe(403);
    });

    it('links a guardian email that belongs to a Super Admin: a parent may hold any other role', async () => {
      const res = await add({ guardians: [guardian({ email: superAdmin.email })] });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        guardians: [{ email: superAdmin.email, hasLogin: true }],
      });
    });
  });

  describe('STU-03 profile', () => {
    it('shows the student to an Owner and to the Admin of the Institution', async () => {
      const student = await added({ admissionNo: 'GVS-2' });
      for (const token of [owner.token, institutionAdmin.token]) {
        const res = await api('get', `/v1/students/${student.id}`, token);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ id: student.id, admissionNo: 'GVS-2', status: 1 });
      }
    });

    it('is 404 for another Society, for an Institution the caller does not reach, and for no such student', async () => {
      const student = await added();
      const elsewhere = await fixtures.institutionAdmin(societyA, [second]);
      for (const [token, id] of [
        [otherOwner.token, student.id],
        [elsewhere.token, student.id],
        [owner.token, missing],
      ] as const) {
        expect((await api('get', `/v1/students/${id}`, token)).status).toBe(404);
      }
      expect((await api('get', '/v1/students/not-a-uuid', owner.token)).status).toBe(404);
    });
  });

  describe('STU-01 list', () => {
    /** Zara in 9-A (roll 3), Asha in 9-A (roll 10), Meera in 9-B (roll 1), Dev in 10-A (roll 1). */

    it('lists the active students by name, a page at a time, with where each sits', async () => {
      const { asha } = await class9();
      const res = await list('?limit=3');
      expect(res.status).toBe(200);
      expect(namesOf(res)).toEqual(['Asha', 'Dev', 'Meera']);
      expect(res.body.meta).toEqual({ page: 1, limit: 3, totalItems: 4, totalPages: 2 });
      expect((res.body.data as unknown as StudentData[])[0]).toMatchObject({
        id: asha.id,
        admissionNo: 'ADM-100',
        placement: {
          academicYearId: year,
          classId: classNine,
          sectionId: sectionA,
          rollNumber: '10',
        },
      });
      expect(namesOf(await list('?limit=3&page=2'))).toEqual(['Zara']);
    });

    it('filters by class, section and year, and shows the placement of the year asked for', async () => {
      await class9();
      expect(namesOf(await list(`?classId=${classNine}`))).toEqual(['Asha', 'Meera', 'Zara']);
      expect(namesOf(await list(`?sectionId=${sectionA}`))).toEqual(['Asha', 'Zara']);
      expect(namesOf(await list(`?classId=${classTen}&sectionId=${sectionTen}`))).toEqual(['Dev']);
      expect(namesOf(await list(`?academicYearId=${year}&sectionId=${sectionB}`))).toEqual([
        'Meera',
      ]);
      expect(namesOf(await list(`?academicYearId=${missing}`))).toEqual([]);
      expect(namesOf(await list(`?sectionId=${missing}`))).toEqual([]);
    });

    it('searches by name, Admission ID and roll number, ignoring letter case, and takes % and _ literally', async () => {
      await class9();
      expect(namesOf(await list('?q=ZAR'))).toEqual(['Zara']);
      expect(namesOf(await list('?q=khan'))).toEqual(['Zara']);
      expect(namesOf(await list('?q=adm-1'))).toEqual(['Asha']);
      expect(namesOf(await list('?q=10'))).toEqual(['Asha']);
      expect(namesOf(await list('?q=%25%25'))).toEqual([]);
      expect(namesOf(await list('?q=_a'))).toEqual([]);
    });

    it('puts the numeric roll numbers first in numeric order, then the rest in text order', async () => {
      for (const rollNumber of ['100', 'A1', '9', '10', 'B', '2A']) {
        await added({ firstName: `R${rollNumber}`, ...roll(rollNumber) });
      }
      expect(namesOf(await list(`?sectionId=${sectionA}&sort=rollNumber`))).toEqual([
        'R9',
        'R10',
        'R100',
        'R2A',
        'RA1',
        'RB',
      ]);
      expect(namesOf(await list(`?sectionId=${sectionA}&sort=-rollNumber`))).toEqual([
        'RB',
        'RA1',
        'R2A',
        'R100',
        'R10',
        'R9',
      ]);
    });

    it('sorts by roll number in numeric order, by Admission ID with the missing last, and either way round', async () => {
      await class9();
      expect(namesOf(await list(`?sectionId=${sectionA}&sort=rollNumber`))).toEqual([
        'Zara',
        'Asha',
      ]);
      expect(namesOf(await list(`?sectionId=${sectionA}&sort=-rollNumber`))).toEqual([
        'Asha',
        'Zara',
      ]);
      expect(namesOf(await list('?sort=admissionNo,name'))).toEqual([
        'Asha',
        'Zara',
        'Dev',
        'Meera',
      ]);
      expect(namesOf(await list('?sort=-admissionNo,name'))).toEqual([
        'Zara',
        'Asha',
        'Dev',
        'Meera',
      ]);
      expect((await list('?sort=nope')).status).toBe(400);
    });

    it('lists only the Institutions the caller reaches, and 404 for one it does not', async () => {
      await class9();
      const elsewhere = await fixtures.institutionAdmin(societyA, [second]);
      expect(namesOf(await list('', institutionAdmin.token))).toHaveLength(4);
      expect(namesOf(await list('', elsewhere.token))).toEqual([]);
      expect(namesOf(await list('', otherOwner.token))).toEqual([]);
      expect((await list(`?institutionId=${first}`, elsewhere.token)).status).toBe(404);
      expect(namesOf(await list(`?institutionId=${first}`))).toHaveLength(4);
      expect(namesOf(await list(`?institutionId=${second}`))).toEqual([]);
      expect(namesOf(await list('?status=0'))).toEqual([]);
    });

    it('is for Owners and Admins: a Teacher gets 403', async () => {
      const teacher = await kit.staff(owner.token, first, categoryId);
      const token = await kit.actingAs(teacher.person.email, 4, societyA);
      expect((await list('', token)).status).toBe(403);
    });
  });

  describe('the student tables', () => {
    it('are hidden from another Society, cannot be deleted, and refuse a write that names another Society', async () => {
      const student = await added();
      const otherSociety = otherOwner.contexts[0]!.societyId!;
      for (const table of [
        'students',
        'student_guardians',
        'student_enrolments',
        'student_section_placements',
      ] as const) {
        expect(
          await database.transaction({ societyId: otherSociety, institutionIds: [first] }, (tx) =>
            tx.selectFrom(table).selectAll().execute(),
          ),
        ).toEqual([]);
        expect(
          (await database.transaction(tenant(), (tx) => tx.selectFrom(table).selectAll().execute()))
            .length,
        ).toBeGreaterThan(0);
        // An Institution the caller does not reach is hidden too.
        expect(
          await database.transaction(tenant([second]), (tx) =>
            tx.selectFrom(table).selectAll().execute(),
          ),
        ).toEqual([]);
      }
      // A record is deactivated, never deleted: the app role has no delete right on three of them, and no delete
      // policy on the fourth, where a placement entered by mistake is removed once a slice does that.
      for (const table of ['students', 'student_guardians', 'student_enrolments'] as const) {
        await expect(
          database.transaction(tenant(), (tx) => sql`delete from ${sql.table(table)}`.execute(tx)),
        ).rejects.toThrow(/permission denied/);
      }
      const removed = await database.transaction(tenant(), (tx) =>
        sql`delete from student_section_placements`.execute(tx),
      );
      expect(removed.numAffectedRows).toBe(0n);
      await expect(
        database.transaction(tenant(), (tx) =>
          sql`insert into students (society_id, institution_id, first_name)
            values (${otherSociety}, ${first}, 'X')`.execute(tx),
        ),
      ).rejects.toThrow(/row-level security|foreign key/);
      await expect(
        database.transaction(tenant(), (tx) =>
          sql`update students set institution_id = ${second} where id = ${student.id}`.execute(tx),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('keep one section at a time, a section of the enrolment’s class, and a roll number once among the current', async () => {
      const student = await added(roll('r1'));
      const other = await added({ firstName: 'Kabir', ...roll('2') });
      const enrolment = student.placement.enrolmentId;
      const insert = (
        section: string,
        rollNo: string,
        start: string,
        end: string | null,
        enrolmentId = enrolment,
      ) =>
        sql`insert into student_section_placements
          (society_id, institution_id, academic_year_id, student_enrolment_id, class_id, section_id, roll_number, start_date, end_date)
          values (${societyA}, ${first}, ${year}, ${enrolmentId}, ${classNine}, ${section}, ${rollNo}, ${start}, ${end})`;
      // The current placement is open; another from the same day overlaps it.
      await expect(refused(insert(sectionB, '5', '2030-01-01', null))).rejects.toThrow(
        /ex_placements_no_overlap/,
      );
      // A section of another class is not allowed for this enrolment (a closed row, so nothing overlaps).
      await expect(
        refused(
          sql`insert into student_section_placements
            (society_id, institution_id, academic_year_id, student_enrolment_id, class_id, section_id, roll_number, start_date, end_date)
            values (${societyA}, ${first}, ${year}, ${enrolment}, ${classNine}, ${sectionTen}, '7', '2020-01-01', '2020-01-02')`,
        ),
      ).rejects.toThrow(/fk_placements_section/);
      // The roll number of a current student of the section is taken, in any case: close the other student's own
      // placement, so only the roll number is in the way.
      await refused(
        sql`update student_section_placements set end_date = start_date + 1
          where student_enrolment_id = ${other.placement.enrolmentId}`,
      );
      await expect(
        refused(
          sql`insert into student_section_placements
            (society_id, institution_id, academic_year_id, student_enrolment_id, class_id, section_id, roll_number, start_date)
            select society_id, institution_id, academic_year_id, student_enrolment_id, class_id, section_id, 'R1', start_date + 2
            from student_section_placements where student_enrolment_id = ${other.placement.enrolmentId}`,
        ),
      ).rejects.toThrow(/uq_placements_roll/);
      // An end before the start is refused.
      await expect(refused(insert(sectionB, '8', '2020-02-01', '2020-01-01'))).rejects.toThrow(
        /ck_placements_dates/,
      );
    });

    it('allow one active enrolment a student and year, one primary guardian, and a person once for a student', async () => {
      const parent = guardian();
      const student = await added({ guardians: [parent] });
      await expect(
        refused(
          sql`insert into student_enrolments (society_id, institution_id, academic_year_id, student_id, class_id, enrolled_date)
            values (${societyA}, ${first}, ${year}, ${student.id}, ${classNine}, '2026-06-02')`,
        ),
      ).rejects.toThrow(/uq_student_enrolments_student_year/);
      await expect(
        refused(
          sql`insert into student_guardians (society_id, institution_id, student_id, first_name, relation, country_code, phone_number, is_primary)
            values (${societyA}, ${first}, ${student.id}, 'Lata', 2, '91', '9845012347', true)`,
        ),
      ).rejects.toThrow(/uq_student_guardians_primary/);
      const userId = (await usersWith(parent.email))[0]!.id;
      await expect(
        refused(
          sql`insert into student_guardians (society_id, institution_id, student_id, user_id, email, first_name, relation, country_code, phone_number)
            values (${societyA}, ${first}, ${student.id}, ${userId}, ${parent.email}, 'Lata', 2, '91', '9845012347')`,
        ),
      ).rejects.toThrow(/uq_student_guardians_student_user/);
      await expect(
        refused(
          sql`insert into student_guardians (society_id, institution_id, student_id, user_id, first_name, relation, country_code, phone_number)
            values (${societyA}, ${first}, ${student.id}, ${userId}, 'Lata', 2, '91', '9845012347')`,
        ),
      ).rejects.toThrow(/ck_student_guardians_login/);
    });

    it('show a person their own guardian rows in any Institution, and nobody else’s', async () => {
      const parent = guardian();
      const student = await added({ guardians: [parent] });
      const userId = (await usersWith(parent.email))[0]!.id;
      const asParent = await database.transaction(
        { societyId: otherOwner.contexts[0]!.societyId!, personId: userId },
        (tx) => tx.selectFrom('student_guardians').select('student_id').execute(),
      );
      expect(asParent).toEqual([{ student_id: student.id }]);
      const asStranger = await database.transaction(
        { societyId: otherOwner.contexts[0]!.societyId!, personId: newId() },
        (tx) => tx.selectFrom('student_guardians').select('student_id').execute(),
      );
      expect(asStranger).toEqual([]);
    });
  });

  describe('the section blocks for a guardian', () => {
    it('answer for a guardian of a student in the Society, with the name of the Society', async () => {
      const parent = guardian();
      await added({ guardians: [parent] });
      const userId = (await usersWith(parent.email))[0]!.id;
      await blocks.setBlock(ownerDb, societyA, first, 3, true);
      expect(await blocksOf(userId)).toEqual([{ section: 3, institution_id: first }]);
      const { rows } = await sql<{ name: string | null }>`
        select app_society_name(${societyA}, ${userId}) as name`.execute(ownerDb);
      expect(rows[0]?.name).toBe('Sunrise Trust');
      // Another Society's blocks, and a person who is nobody's guardian here, are not shown.
      expect(await blocksOf(userId, otherOwner.contexts[0]!.societyId!)).toEqual([]);
      expect(await blocksOf(newId())).toEqual([]);
    });

    it('stop answering once every child of the guardian is deactivated, but not while one stays', async () => {
      const parent = guardian();
      const gone = await added({ guardians: [parent] });
      const stays = await added({ ...roll('2'), guardians: [{ ...parent }] });
      const userId = (await usersWith(parent.email))[0]!.id;
      await blocks.setBlock(ownerDb, societyA, first, 3, true);
      await deactivateRow(gone.id);
      expect(await blocksOf(userId)).toEqual([{ section: 3, institution_id: first }]);
      await deactivateRow(stays.id);
      expect(await blocksOf(userId)).toEqual([]);
    });
  });
});
