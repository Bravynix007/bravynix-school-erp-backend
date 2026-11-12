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

const fieldCodes = (res: { body: { errors?: { field: string; code: string }[] } }) =>
  res.body.errors?.map(({ field, code }) => ({ field, code }));

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
  const enrolmentOf = async (id: string) =>
    (
      await database.transaction(tenant(), (tx) =>
        sql<{ status: number; left_date: string | null; outcome: number | null }>`
          select status, left_date::text, outcome from student_enrolments where student_id = ${id}`.execute(
          tx,
        ),
      )
    ).rows[0]!;
  const openPlacements = async (id: string) =>
    (
      await database.transaction(tenant(), (tx) =>
        sql<{ n: number }>`
          select count(*)::int as n from student_section_placements p
          join student_enrolments e on e.id = p.student_enrolment_id
          where e.student_id = ${id} and p.end_date is null`.execute(tx),
      )
    ).rows[0]!.n;
  const move = (id: string, fields: object, token = owner.token) =>
    api('patch', `/v1/students/${id}/placement`, token, fields);
  const placements = async (id: string) =>
    (
      await database.transaction(tenant(), (tx) =>
        sql<{
          section_id: string;
          roll_number: string;
          start_date: string;
          end_date: string | null;
        }>`
          select p.section_id, p.roll_number, p.start_date::text, p.end_date::text
          from student_section_placements p join student_enrolments e on e.id = p.student_enrolment_id
          where e.student_id = ${id} order by p.start_date`.execute(tx),
      )
    ).rows;
  /** In 9-A, roll 7, since 1 May: the test clock says it is 1 June, so the placement is backdated by hand. */
  const sinceMay = async () => {
    const student = await added(roll('7'));
    await refused(
      sql`update student_section_placements set start_date = '2026-05-01'
        where student_enrolment_id = ${student.placement.enrolmentId}`,
    );
    return student;
  };
  const patch = (id: string, fields: object, token = owner.token) =>
    api('patch', `/v1/students/${id}`, token, fields);
  const deactivate = (id: string, reason: number | undefined = 1, token = owner.token) =>
    api('delete', `/v1/students/${id}`, token, reason === undefined ? {} : { reason });
  const deactivateRow = (id: string) =>
    refused(
      sql`update students set status = 0, inactive_reason = 3, inactive_at = now() where id = ${id}`,
    );
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
      // The ID is free again once the first student is deactivated.
      const gone = await added({ admissionNo: 'GVS-GONE', ...roll('3') });
      await deactivateRow(gone.id);
      expect((await add({ admissionNo: 'gvs-gone', ...roll('4') })).status).toBe(201);
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

    it('refuses to make a guardian a Super Admin: the platform team and the parents are kept apart both ways', async () => {
      const parent = guardian();
      await added({ guardians: [parent] });
      const refusedAdmin = await api('post', '/v1/platform/super-admins', admin, {
        email: parent.email,
      });
      expect([refusedAdmin.status, refusedAdmin.body.code]).toEqual([409, 'ROLE_CONFLICT']);
      const holds = await sql<{ n: number }>`
        select count(*)::int as n from role_assignments g join users u on u.id = g.user_id
        where u.email = ${parent.email}`.execute(ownerDb);
      expect(holds.rows[0]!.n).toBe(0);
    });

    it('refuses a guardian email that belongs to a Super Admin, and links a teacher', async () => {
      const res = await add({ guardians: [guardian({ email: superAdmin.email })] });
      expect([res.status, res.body.code]).toEqual([409, 'ROLE_CONFLICT']);
      const teacher = await kit.staff(owner.token, first, categoryId);
      const linked = await add({
        guardians: [guardian({ email: teacher.person.email })],
        ...roll('8'),
      });
      expect(linked.status).toBe(201);
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

  describe('STU-04 edit', () => {
    it('changes the personal and contact fields by version, stamps the author and audits the change', async () => {
      const student = await added({ admissionNo: 'GVS-4' });
      const res = await patch(student.id, {
        version: 1,
        firstName: 'Diyaa',
        lastName: 'Rao',
        gender: 2,
        dateOfBirth: '2014-03-09',
        bloodGroup: 'O+',
        nationality: 'Indian',
        admissionNo: 'GVS-40',
        contactEmail: 'Diya.Own@Example.com',
        mobile: { countryCode: '91', number: '9000000001' },
        alternateNumber: '9000000002',
        address: { line1: '12 Lake Road', ...place },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: student.id,
        firstName: 'Diyaa',
        lastName: 'Rao',
        gender: 2,
        dateOfBirth: '2014-03-09',
        bloodGroup: 'O+',
        nationality: 'Indian',
        admissionNo: 'GVS-40',
        contactEmail: 'diya.own@example.com',
        mobile: { countryCode: '91', number: '9000000001' },
        address: { line1: '12 Lake Road', ...place },
        version: 2,
        placement: { sectionId: sectionA, rollNumber: student.placement.rollNumber },
      });
      const entries = (await audit(student.id)).filter((e) => e.action === 'student.updated');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor_user_id: owner.person,
        institution_id: first,
        old_values: expect.objectContaining({ firstName: 'Diya' }),
        new_values: expect.objectContaining({ firstName: 'Diyaa', mobile: '******0001' }),
      });
      const text = JSON.stringify(entries[0]);
      for (const secret of ['diya.own@example.com', '12 Lake Road', '9000000001']) {
        expect(text).not.toContain(secret);
      }
    });

    it('clears optional fields with null, and leaves what it is not sent', async () => {
      const student = await added({
        lastName: 'Shetty',
        nationality: 'Indian',
        contactEmail: 'a@example.com',
      });
      const res = await patch(student.id, { version: 1, lastName: null, contactEmail: null });
      expect(res.body.data).toMatchObject({
        lastName: null,
        contactEmail: null,
        nationality: 'Indian',
        version: 2,
      });
    });

    it('writes nothing, and no audit entry, for a request that changes nothing', async () => {
      const student = await added({ lastName: 'Shetty' });
      const res = await patch(student.id, { version: 1, lastName: 'Shetty', firstName: 'Diya' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ version: 1 });
      expect((await audit(student.id)).filter((e) => e.action === 'student.updated')).toEqual([]);
    });

    it('answers 409 VERSION_CONFLICT for a stale version, before the body is looked at', async () => {
      const student = await added();
      await patch(student.id, { version: 1, lastName: 'Rao' });
      const stale = await patch(student.id, { version: 1, dateOfBirth: '2999-01-01' });
      expect([stale.status, stale.body.code]).toEqual([409, 'VERSION_CONFLICT']);
    });

    it('refuses the dates as they will stand, and a name of only spaces', async () => {
      const student = await added({ dateOfBirth: '2014-03-09' });
      for (const [fields, field, code] of [
        [{ dateOfBirth: '2999-01-01' }, 'dateOfBirth', 'INVALID_VALUE'],
        [{ admissionDate: '2010-01-01' }, 'admissionDate', 'INVALID_VALUE'],
        [{ firstName: '   ' }, 'firstName', 'TOO_SHORT'],
        [{ firstName: null }, 'firstName', 'INVALID_TYPE'],
        [{ institutionId: first }, 'institutionId', 'FIELD_NOT_ALLOWED'],
        [{ guardians: [] }, 'guardians', 'FIELD_NOT_ALLOWED'],
      ] as const) {
        const res = await patch(student.id, { version: 1, ...fields });
        expect([res.status, fieldCodes(res)]).toEqual([400, [{ field, code }]]);
      }
    });

    it('keeps the Admission ID once among active students, and frees it when a student is deactivated', async () => {
      const one = await added({ admissionNo: 'GVS-5' });
      const two = await added({ admissionNo: 'GVS-6', ...roll('2') });
      const taken = await patch(two.id, { version: 1, admissionNo: 'gvs-5' });
      expect([taken.status, taken.body.code]).toEqual([409, 'ADMISSION_NO_TAKEN']);
      expect(
        (await api('delete', `/v1/students/${one.id}`, owner.token, { reason: 1 })).status,
      ).toBe(200);
      expect((await patch(two.id, { version: 1, admissionNo: 'GVS-5' })).status).toBe(200);
    });

    it('takes a Ready photo of purpose 3 once, and checks a new place against the masters', async () => {
      const student = await added();
      const photo = await readyPhoto();
      const ok = await patch(student.id, { version: 1, photoFileId: photo });
      expect(ok.body.data).toMatchObject({ photoFileId: photo, version: 2 });
      const other = await added({ ...roll('2') });
      const again = await patch(other.id, { version: 1, photoFileId: photo });
      expect([again.status, again.body.errors?.[0]?.field]).toEqual([400, 'photoFileId']);
      const wrong = await patch(other.id, { version: 1, photoFileId: await readyPhoto(first, 4) });
      expect([wrong.status, wrong.body.errors?.[0]?.field]).toEqual([400, 'photoFileId']);
      const city = await patch(other.id, { version: 1, address: { stateId: place.stateId } });
      expect(city.status).toBe(400);
      expect(city.body.errors?.[0]?.field).toContain('address');
    });

    it('is 404 for another Society, an Institution the caller does not reach, no such student and a deactivated one', async () => {
      const student = await added();
      const elsewhere = await fixtures.institutionAdmin(societyA, [second]);
      for (const [token, id] of [
        [otherOwner.token, student.id],
        [elsewhere.token, student.id],
        [owner.token, missing],
      ] as const) {
        expect((await patch(id, { version: 1, lastName: 'X' }, token)).status).toBe(404);
      }
      await api('delete', `/v1/students/${student.id}`, owner.token, { reason: 3 });
      expect((await patch(student.id, { version: 2, lastName: 'X' })).status).toBe(404);
    });

    it('lets an Institution Admin edit', async () => {
      const student = await added();
      const res = await patch(student.id, { version: 1, lastName: 'Rao' }, institutionAdmin.token);
      expect(res.status).toBe(200);
    });
  });

  describe('STU-05 deactivate', () => {
    it('deactivates with a reason, ends the placement today, and closes the enrolment as left', async () => {
      const student = await added({ admissionNo: 'GVS-7' });
      const res = await deactivate(student.id, 1);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: student.id, status: 0 });
      const today = t.clock.todayIst();
      expect(await enrolmentOf(student.id)).toEqual({ status: 1, left_date: today, outcome: 3 });
      expect(await openPlacements(student.id)).toBe(0);
      const row = (
        await database.transaction(tenant(), (tx) =>
          sql<{ status: number; inactive_reason: number; inactive_at: Date }>`
            select status, inactive_reason, inactive_at from students where id = ${student.id}`.execute(
            tx,
          ),
        )
      ).rows[0]!;
      expect([row.status, row.inactive_reason]).toEqual([0, 1]);
      expect(row.inactive_at).toBeInstanceOf(Date);
      const entries = (await audit(student.id)).filter((e) => e.action === 'student.deactivated');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor_user_id: owner.person,
        old_values: expect.objectContaining({ status: 1 }),
        new_values: expect.objectContaining({ status: 0, inactiveReason: 1 }),
      });
    });

    it('cancels the enrolment of a record made by mistake', async () => {
      const student = await added();
      expect((await deactivate(student.id, 2)).status).toBe(200);
      expect(await enrolmentOf(student.id)).toMatchObject({ status: 0, outcome: null });
    });

    it('frees the Admission ID and the roll number, and leaves the record readable and listed as inactive', async () => {
      const student = await added({ admissionNo: 'GVS-8', ...roll('21') });
      await deactivate(student.id, 3);
      const again = await add({ admissionNo: 'GVS-8', ...roll('21') });
      expect(again.status).toBe(201);
      const profile = await api('get', `/v1/students/${student.id}`, owner.token);
      expect(profile.body.data).toMatchObject({
        status: 0,
        placement: { sectionId: sectionA, rollNumber: '21' },
      });
      const listed = await api('get', '/v1/students?status=0', owner.token);
      expect((listed.body.data as unknown as { id: string }[]).map((s) => s.id)).toContain(
        student.id,
      );
      const active = await api('get', '/v1/students', owner.token);
      expect((active.body.data as unknown as { id: string }[]).map((s) => s.id)).not.toContain(
        student.id,
      );
    });

    it('is 404 the second time, and for a student the caller does not reach', async () => {
      const student = await added();
      expect((await deactivate(student.id)).status).toBe(200);
      expect((await deactivate(student.id)).status).toBe(404);
      const other = await added(roll('2'));
      const elsewhere = await fixtures.institutionAdmin(societyA, [second]);
      for (const [token, id] of [
        [otherOwner.token, other.id],
        [elsewhere.token, other.id],
        [owner.token, missing],
      ] as const) {
        expect((await deactivate(id, 1, token)).status).toBe(404);
      }
    });

    it('needs a reason of 1, 2 or 3', async () => {
      const student = await added();
      for (const reason of [undefined, 0, 4, '1']) {
        const res = await api(
          'delete',
          `/v1/students/${student.id}`,
          owner.token,
          reason === undefined ? {} : { reason },
        );
        expect(res.status).toBe(400);
        expect(res.body.errors?.[0]?.field).toBe('reason');
      }
      expect((await api('get', `/v1/students/${student.id}`, owner.token)).body.data).toMatchObject(
        { status: 1 },
      );
    });

    it('stops a parent’s section blocks for a child who is gone, but not for a sibling who stays', async () => {
      const parent = guardian();
      const gone = await added({ guardians: [parent] });
      const stays = await added({ ...roll('2'), guardians: [{ ...parent }] });
      const userId = (await usersWith(parent.email))[0]!.id;
      await blocks.setBlock(ownerDb, societyA, first, 3, true);
      expect(await blocksOf(userId)).toEqual([{ section: 3, institution_id: first }]);
      await deactivate(gone.id);
      expect(await blocksOf(userId)).toEqual([{ section: 3, institution_id: first }]);
      await deactivate(stays.id);
      expect(await blocksOf(userId)).toEqual([]);
    });

    it('is refused by the database for a deactivated record without a reason, and an active one with one', async () => {
      const student = await added();
      await expect(
        refused(sql`update students set status = 0 where id = ${student.id}`),
      ).rejects.toThrow(/ck_students_inactive/);
      await expect(
        refused(sql`update students set inactive_reason = 1 where id = ${student.id}`),
      ).rejects.toThrow(/ck_students_inactive/);
      await expect(
        refused(
          sql`update students set status = 0, inactive_reason = 4, inactive_at = now() where id = ${student.id}`,
        ),
      ).rejects.toThrow(/ck_students_inactive/);
    });
  });

  describe('STU-08 move', () => {
    it('closes the placement the day before and opens the next, with the new section and roll number', async () => {
      const student = await sinceMay();
      const res = await move(student.id, {
        sectionId: sectionB,
        rollNumber: '3',
        effectiveDate: '2026-05-20',
      });
      expect(res.status).toBe(200);
      expect(res.body.meta).toBeNull();
      expect(res.body.data).toMatchObject({
        placement: { sectionId: sectionB, rollNumber: '3', startDate: '2026-05-20' },
      });
      expect(await placements(student.id)).toEqual([
        {
          section_id: sectionA,
          roll_number: '7',
          start_date: '2026-05-01',
          end_date: '2026-05-19',
        },
        { section_id: sectionB, roll_number: '3', start_date: '2026-05-20', end_date: null },
      ]);
      const entries = (await audit(student.id)).filter(
        (e) => e.action === 'student.placement_changed',
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor_user_id: owner.person,
        old_values: expect.objectContaining({ sectionId: sectionA, rollNumber: '7' }),
        new_values: expect.objectContaining({ sectionId: sectionB, rollNumber: '3' }),
      });
    });

    it('takes today as the day, and keeps the section or the roll number it is not sent', async () => {
      const student = await sinceMay();
      const res = await move(student.id, { rollNumber: '8' });
      expect(res.body.data).toMatchObject({
        placement: { sectionId: sectionA, rollNumber: '8', startDate: t.clock.todayIst() },
      });
      expect((await placements(student.id)).map((p) => [p.roll_number, p.end_date])).toEqual([
        ['7', '2026-05-31'],
        ['8', null],
      ]);
      const section = await move(student.id, { sectionId: sectionB });
      expect(section.body.data).toMatchObject({
        placement: { sectionId: sectionB, rollNumber: '8' },
      });
    });

    it('corrects the placement in place on the day it began', async () => {
      const student = await added(roll('7'));
      const res = await move(student.id, { rollNumber: '70' });
      expect(res.status).toBe(200);
      expect(await placements(student.id)).toEqual([
        {
          section_id: sectionA,
          roll_number: '70',
          start_date: t.clock.todayIst(),
          end_date: null,
        },
      ]);
    });

    it('writes nothing, and no audit entry, for a request that changes nothing', async () => {
      const student = await sinceMay();
      for (const fields of [
        {},
        { sectionId: sectionA, rollNumber: '7', effectiveDate: '2026-05-10' },
      ]) {
        const res = await move(student.id, fields);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
          placement: { sectionId: sectionA, rollNumber: '7' },
        });
      }
      expect(await placements(student.id)).toHaveLength(1);
      expect(
        (await audit(student.id)).filter((e) => e.action === 'student.placement_changed'),
      ).toEqual([]);
    });

    it('refuses a day in the future or before the placement began', async () => {
      const student = await sinceMay();
      for (const effectiveDate of ['2026-06-02', '2026-04-30']) {
        const res = await move(student.id, { rollNumber: '8', effectiveDate });
        expect([res.status, fieldCodes(res)]).toEqual([
          400,
          [{ field: 'effectiveDate', code: 'INVALID_VALUE' }],
        ]);
      }
    });

    it('is 409 ROLL_NUMBER_TAKEN for a roll number in use in the section, and lets a freed one be taken', async () => {
      const one = await added(roll('1'));
      const two = await sinceMay();
      const taken = await move(two.id, { rollNumber: '1' });
      expect([taken.status, taken.body.code]).toEqual([409, 'ROLL_NUMBER_TAKEN']);
      expect(await placements(two.id)).toHaveLength(1);
      await api('delete', `/v1/students/${one.id}`, owner.token, { reason: 1 });
      expect((await move(two.id, { rollNumber: '1' })).status).toBe(200);
    });

    it('is 422 for a section of another class, 404 for a section of another Institution, and 422 for a closed section', async () => {
      const student = await sinceMay();
      const otherClass = await move(student.id, { sectionId: sectionTen });
      expect([otherClass.status, otherClass.body.code]).toEqual([422, 'SECTION_NOT_IN_CLASS']);
      const abroad = await move(student.id, { sectionId: missing });
      expect(abroad.status).toBe(404);
      const closed = await kit.section(
        owner.token,
        classNine,
        (await masters('predefined-sections')).find((c) => c.code === 'C')!.id,
      );
      await api('delete', `/v1/sections/${closed}`, owner.token);
      const inactive = await move(student.id, { sectionId: closed });
      expect([inactive.status, inactive.body.code]).toEqual([422, 'INACTIVE_SECTION']);
      expect(await placements(student.id)).toHaveLength(1);
    });

    it('warns, and still moves, when the new section is over its capacity', async () => {
      const set = await api('patch', `/v1/sections/${sectionB}`, owner.token, {
        version: 1,
        capacity: 1,
      });
      expect(set.status).toBe(200);
      await added(roll('1', { ...where(), sectionId: sectionB }));
      const student = await sinceMay();
      const res = await move(student.id, { sectionId: sectionB, rollNumber: '2' });
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ warnings: ['SECTION_OVER_CAPACITY'] });
    });

    it('is 404 for another Society, an Institution the caller does not reach, no such student and a deactivated one, and 400 for an unknown field', async () => {
      const student = await sinceMay();
      const elsewhere = await fixtures.institutionAdmin(societyA, [second]);
      for (const [token, id] of [
        [otherOwner.token, student.id],
        [elsewhere.token, student.id],
        [owner.token, missing],
      ] as const) {
        expect((await move(id, { rollNumber: '9' }, token)).status).toBe(404);
      }
      const unknown = await move(student.id, { classId: classTen });
      expect([unknown.status, fieldCodes(unknown)]).toEqual([
        400,
        [{ field: 'classId', code: 'FIELD_NOT_ALLOWED' }],
      ]);
      await api('delete', `/v1/students/${student.id}`, owner.token, { reason: 1 });
      expect((await move(student.id, { rollNumber: '9' })).status).toBe(404);
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

    it('give a roll number back when the placement is closed: a current placement may take it', async () => {
      const first1 = await added(roll('5'));
      await refused(
        sql`update student_section_placements set end_date = start_date
          where student_enrolment_id = ${first1.placement.enrolmentId}`,
      );
      expect((await add({ firstName: 'Kabir', ...roll('5') })).status).toBe(201);
    });

    it('refuse an insert for another Institution of the same Society, in each table', async () => {
      const attempts = [
        sql`insert into students (society_id, institution_id, first_name)
          values (${societyA}, ${second}, 'X')`,
        sql`insert into student_guardians
          (society_id, institution_id, student_id, first_name, relation, country_code, phone_number)
          values (${societyA}, ${second}, ${newId()}, 'X', 1, '91', '9845012345')`,
        sql`insert into student_enrolments
          (society_id, institution_id, academic_year_id, student_id, class_id, enrolled_date)
          values (${societyA}, ${second}, ${newId()}, ${newId()}, ${newId()}, '2026-06-01')`,
        sql`insert into student_section_placements
          (society_id, institution_id, academic_year_id, student_enrolment_id, class_id, section_id, roll_number, start_date)
          values (${societyA}, ${second}, ${newId()}, ${newId()}, ${newId()}, ${newId()}, '1', '2026-06-01')`,
      ];
      for (const attempt of attempts) {
        await expect(refused(attempt)).rejects.toThrow(/row-level security/);
      }
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

    it('answer only for the Society asked about, even when that Society has a block in force', async () => {
      const parent = guardian();
      await added({ guardians: [parent] });
      const userId = (await usersWith(parent.email))[0]!.id;
      const societyB = otherOwner.contexts[0]!.societyId!;
      await blocks.setBlock(ownerDb, societyB, null, 1, true);
      expect(await blocksOf(userId, societyB)).toEqual([]);
      const { rows } = await sql<{ name: string | null }>`
        select app_society_name(${societyB}, ${userId}) as name`.execute(ownerDb);
      expect(rows[0]?.name).toBeNull();
    });

    it('put every setting of the caller back after they answer', async () => {
      const parent = guardian();
      await added({ guardians: [parent] });
      const userId = (await usersWith(parent.email))[0]!.id;
      const otherSociety = otherOwner.contexts[0]!.societyId!;
      await blocks.setBlock(ownerDb, societyA, first, 3, true);
      const settings = (tx: Parameters<Parameters<typeof database.transaction>[1]>[0]) =>
        sql<{ values: string[] }>`
          select array[
            current_setting('app.role_code', true), current_setting('app.society_id', true),
            current_setting('app.person_id', true), current_setting('app.institution_ids', true)
          ] as values`.execute(tx);
      const unchanged = await database.transaction(tenant([first, second]), async (tx) => {
        const before = (await settings(tx)).rows[0]!.values;
        const seen = await sql<{ section: number }>`
          select section from app_active_blocks(${societyA}, ${userId})`.execute(tx);
        const afterBlocks = (await settings(tx)).rows[0]!.values;
        await sql`select app_society_name(${societyA}, ${userId})`.execute(tx);
        const afterName = (await settings(tx)).rows[0]!.values;
        // Asked about another Society, the caller's own Society must still be put back.
        await sql`select * from app_active_blocks(${otherSociety}, ${userId})`.execute(tx);
        const afterOtherBlocks = (await settings(tx)).rows[0]!.values;
        await sql`select app_society_name(${otherSociety}, ${userId})`.execute(tx);
        const afterOtherName = (await settings(tx)).rows[0]!.values;
        return {
          before,
          afterBlocks,
          afterName,
          afterOtherBlocks,
          afterOtherName,
          seen: seen.rows.length,
        };
      });
      expect(unchanged.seen).toBe(1);
      expect(unchanged.before[3]).toBe(`${first},${second}`);
      expect(unchanged.afterBlocks).toEqual(unchanged.before);
      expect(unchanged.afterName).toEqual(unchanged.before);
      expect(unchanged.afterOtherBlocks).toEqual(unchanged.before);
      expect(unchanged.afterOtherName).toEqual(unchanged.before);
    });

    it('tell a guardian from a stranger in any Society, and put the role, Society and person back', async () => {
      const parent = guardian();
      await added({ guardians: [parent] });
      const userId = (await usersWith(parent.email))[0]!.id;
      const asked = (person: string) =>
        database.transaction(
          { societyId: otherOwner.contexts[0]!.societyId!, roleCode: 2, personId: owner.person },
          async (tx) => {
            const found = await sql<{
              held: boolean;
            }>`select app_is_guardian(${person}::uuid) as held`.execute(tx);
            const settings = await sql<{ role: string; society: string; person: string }>`
              select current_setting('app.role_code') as role, current_setting('app.society_id') as society,
                current_setting('app.person_id') as person`.execute(tx);
            return { held: found.rows[0]?.held, settings: settings.rows[0] };
          },
        );
      const settings = {
        role: '2',
        society: otherOwner.contexts[0]!.societyId!,
        person: owner.person,
      };
      expect(await asked(userId)).toEqual({ held: true, settings });
      expect(await asked(newId())).toEqual({ held: false, settings });
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
