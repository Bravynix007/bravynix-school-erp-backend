import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
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
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

const email = () => `${newId()}@staff.test`;

const activeBlocksOf = async (db: Kysely<unknown>, society: string, person: string) => {
  const { rows } = await sql<{ section: number; institution_id: string | null }>`
    select * from app_active_blocks(${society}, ${person})
  `.execute(db);
  return rows;
};

describe('STF-02 to STF-05 staff (API design 9.5)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const staffUsers: string[] = [];

  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let societyA: string;
  let first: string;
  let second: string;
  let categoryId: string;
  let designationId: string;
  let place: { countryId: string; stateId: string; cityId: string };

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

  const staffBody = (fields: object = {}) => ({
    homeInstitutionId: first,
    email: email(),
    firstName: 'Meera',
    lastName: 'Iyer',
    classCategoryId: categoryId,
    mobile: { countryCode: '91', number: '9876500001' },
    ...fields,
  });

  /** Adds a staff member and returns the answer; the person's ID is kept so the test can remove it. */
  const add = async (fields: object = {}, token = owner.token) => {
    const res = await api('post', '/v1/staff', token, staffBody(fields));
    const person = (res.body.data as { person?: { id: string } } | undefined)?.person;
    if (person) staffUsers.push(person.id);
    return res;
  };

  const added = async (fields: object = {}, token = owner.token) => {
    const res = await add(fields, token);
    expect(res.status).toBe(201);
    return res.body.data as unknown as StaffData;
  };

  interface StaffData {
    id: string;
    version: number;
    status: number;
    person: { id: string; email: string };
    homeInstitutionId: string;
    firstName: string;
    lastName: string | null;
    employeeCode: string | null;
    photoFileId: string | null;
    mobile: { countryCode: string; number: string };
    address: Record<string, string | null>;
    educations: { degree: string; yearOfPassing: number | null }[];
    emergencyContacts: { contactName: string; isPrimary: boolean }[];
    createdBy: { id: string };
    updatedBy: { id: string };
  }

  const audit = (id: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      institution_id: string | null;
      society_id: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${id}`);

  /** Designations are platform masters: their rows are written as the platform role, as the masters API does. */
  const scratchDesignations: string[] = [];
  const asPlatform = <T>(fn: (trx: Transaction<unknown>) => Promise<T>): Promise<T> =>
    ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(trx);
      return fn(trx);
    });
  const insertDesignation = (id: string, name: string, order: number, status: number) => {
    scratchDesignations.push(id);
    return asPlatform((trx) =>
      sql`
        insert into designations (id, name, code, display_order, status)
        values (${id}, ${name}, ${`H${newId().slice(-8).toUpperCase()}`}, ${order}, ${status})
      `.execute(trx),
    );
  };
  const setDesignationStatus = (id: string, status: number) =>
    asPlatform((trx) =>
      sql`update designations set status = ${status} where id = ${id}`.execute(trx),
    );
  /** After the Societies are gone, so no staff record still points at them. */
  const removeScratchDesignations = async () => {
    for (const id of scratchDesignations.splice(0)) {
      await asPlatform((trx) => sql`delete from designations where id = ${id}`.execute(trx));
    }
  };

  const readyPhoto = async (institutionId = first, purpose = 4, status = 2) => {
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
    const { rows: categories } = await sql<{ id: string }>`
      select id from class_categories where status = 1 order by display_order limit 1
    `.execute(ownerDb);
    categoryId = categories[0]!.id;
    const { rows: designations } = await sql<{ id: string }>`
      select id from designations where status = 1 order by display_order limit 1
    `.execute(ownerDb);
    designationId = designations[0]!.id;
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
    societyA = await makeSociety();
    owner = await fixtures.owner(societyA);
    first = await makeInstitution(owner.token);
    second = await makeInstitution(owner.token);
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
    otherOwner = await fixtures.owner(await makeSociety());
  });

  afterEach(async () => {
    await blocks.clearBlocks(ownerDb);
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    await removeScratchDesignations();
    // The staff logins were made by the owner, so they go first.
    for (const id of staffUsers.splice(0)) {
      await sql`delete from users where id = ${id}`.execute(ownerDb);
    }
    await fixtures.cleanup();
  });

  describe('STF-02 add', () => {
    it('adds a staff member with the login, the lists and the stamps, and emails the welcome after the commit', async () => {
      const address = { line1: '4 Temple Street', ...place, pincode: '560001' };
      const body = staffBody({
        employeeCode: 'EMP-1',
        gender: 2,
        dateOfBirth: '1990-04-12',
        bloodGroup: 'O+',
        nationality: 'Indian',
        designationId,
        alternateNumber: '9876500002',
        address,
        joiningDate: '2024-06-03',
        employmentType: 1,
        educations: [
          { degree: 'B.Ed', yearOfPassing: 2014 },
          {
            degree: 'M.Sc',
            specialization: 'Physics',
            institutionName: 'IISc',
            yearOfPassing: 2012,
          },
        ],
        emergencyContacts: [
          {
            contactName: 'Ravi Iyer',
            relation: 'Spouse',
            phone: { countryCode: '91', number: '9876500003' },
            isPrimary: true,
          },
          {
            contactName: 'Lata Iyer',
            phone: { countryCode: '91', number: '9876500004' },
            isPrimary: false,
          },
        ],
      });
      const res = await api('post', '/v1/staff', owner.token, body);
      expect(res.status).toBe(201);
      const staff = res.body.data as unknown as StaffData;
      staffUsers.push(staff.person.id);
      expect(staff).toMatchObject({
        status: 1,
        version: 1,
        homeInstitutionId: first,
        person: { email: body.email },
        employeeCode: 'EMP-1',
        firstName: 'Meera',
        lastName: 'Iyer',
        mobile: { countryCode: '91', number: '9876500001' },
        address: { line1: '4 Temple Street', ...place, pincode: '560001' },
        createdBy: { id: owner.person },
        updatedBy: { id: owner.person },
      });
      expect(staff.educations.map((e) => e.degree)).toEqual(['B.Ed', 'M.Sc']);
      expect(staff.emergencyContacts.map((c) => [c.contactName, c.isPrimary])).toEqual([
        ['Ravi Iyer', true],
        ['Lata Iyer', false],
      ]);

      // The login is a Pending account, and the welcome names the role and the Society.
      const { rows } = await sql<{
        account_status: number;
      }>`select account_status from users where id = ${staff.person.id}`.execute(ownerDb);
      expect(rows[0]?.account_status).toBe(3);
      const welcome = t.email.latest(body.email, 'welcome');
      expect(welcome?.variables).toMatchObject({ role: 'Teacher', society: 'Sunrise Trust' });

      const read = await api('get', `/v1/staff/${staff.id}`, owner.token);
      expect(read.status).toBe(200);
      expect(read.body.data).toMatchObject({ id: staff.id, firstName: 'Meera', version: 1 });
    });

    it('links an email that already belongs to a person instead of making a second account', async () => {
      const existing = await fixtures.institutionAdmin(societyA, [second]);
      const before = await sql<{
        n: number;
      }>`select count(*)::int as n from users where email = ${existing.email}`.execute(ownerDb);
      const staff = await added({ email: existing.email.toUpperCase() });
      expect(staff.person).toMatchObject({ id: existing.person, email: existing.email });
      const after = await sql<{
        n: number;
      }>`select count(*)::int as n from users where email = ${existing.email}`.execute(ownerDb);
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
      expect(t.email.latest(existing.email, 'welcome')).toBeDefined();
    });

    it('writes the audit entry for the home Institution, with no email and only the last four digits of a number', async () => {
      const staff = await added({
        alternateNumber: '9876500002',
        address: { line1: '4 Temple Street' },
        emergencyContacts: [
          {
            contactName: 'Ravi',
            phone: { countryCode: '91', number: '9876500003' },
            isPrimary: true,
          },
        ],
      });
      const [entry] = await audit(staff.id);
      expect(entry).toMatchObject({
        action: 'staff.created',
        actor_user_id: owner.person,
        society_id: societyA,
        institution_id: first,
      });
      const text = JSON.stringify(entry);
      for (const secret of [
        staff.person.email,
        '9876500001',
        '9876500002',
        '9876500003',
        'Temple',
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(entry?.new_values).toMatchObject({
        mobile: '******0001',
        alternatePhone: '******0002',
      });
    });

    it('answers 409 EMPLOYEE_ID_TAKEN for an Employee ID in use in the Institution, ignoring case, and frees it on deactivation', async () => {
      const one = await added({ employeeCode: 'Emp-7' });
      const clash = await add({ employeeCode: 'EMP-7' });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('EMPLOYEE_ID_TAKEN');
      // Another Institution of the Society may use it.
      expect((await add({ employeeCode: 'EMP-7', homeInstitutionId: second })).status).toBe(201);
      expect((await api('delete', `/v1/staff/${one.id}`, owner.token)).status).toBe(200);
      expect((await add({ employeeCode: 'emp-7' })).status).toBe(201);
    });

    it('answers 409 DUPLICATE for a person who already has an active record in the Society, and takes them again once it is deactivated', async () => {
      const staff = await added();
      const again = await add({ email: staff.person.email, homeInstitutionId: second });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('DUPLICATE');
      expect((await api('delete', `/v1/staff/${staff.id}`, owner.token)).status).toBe(200);
      const back = await add({ email: staff.person.email });
      expect(back.status).toBe(201);
      expect((back.body.data as unknown as StaffData).id).not.toBe(staff.id);
    });

    it('refuses a Super Admin, a blocked account and an inactive account', async () => {
      const sa = await add({ email: superAdmin.email });
      expect(sa.status).toBe(409);
      expect(sa.body.code).toBe('ROLE_CONFLICT');
      const blocked = personaByKey('EDGE-blocked');
      const inactive = personaByKey('EDGE-inactive');
      const b = await add({ email: blocked.email });
      expect(b.status).toBe(409);
      expect(b.body.code).toBe('ACCOUNT_BLOCKED');
      const i = await add({ email: inactive.email });
      expect(i.status).toBe(409);
      expect(i.body.code).toBe('INVALID_STATE');
    });

    it.each([
      ['a date of birth that is not in the past', { dateOfBirth: '2999-01-01' }, 'dateOfBirth'],
      [
        'a resignation before the joining',
        { joiningDate: '2024-06-03', resignationDate: '2024-06-02' },
        'resignationDate',
      ],
      [
        'two primary emergency contacts',
        {
          emergencyContacts: [
            {
              contactName: 'A',
              phone: { countryCode: '91', number: '9876500003' },
              isPrimary: true,
            },
            {
              contactName: 'B',
              phone: { countryCode: '91', number: '9876500004' },
              isPrimary: true,
            },
          ],
        },
        'emergencyContacts[1].isPrimary',
      ],
    ])('refuses %s with 400 on the field', async (_name, fields, field) => {
      const res = await add(fields);
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual([expect.objectContaining({ field, code: 'INVALID_VALUE' })]);
    });

    it('checks the shape of the body: a phone, the lists, a number as text, an unknown field', async () => {
      for (const fields of [
        { mobile: { countryCode: '91', number: '12' } },
        { mobile: undefined },
        { classCategoryId: undefined },
        { gender: 4 },
        { gender: '1' },
        { educations: Array.from({ length: 21 }, () => ({ degree: 'B.Ed' })) },
        {
          emergencyContacts: Array.from({ length: 11 }, () => ({
            contactName: 'A',
            phone: { countryCode: '91', number: '9876500003' },
            isPrimary: false,
          })),
        },
        { bloodGroup: 'C+' },
        { isAdmin: true },
      ]) {
        const res = await add(fields);
        expect({ fields, status: res.status }).toMatchObject({ status: 400 });
      }
    });

    it('checks the masters: a missing entry is 404, a hidden one 422 REFERENCE_INACTIVE, a state outside the country 400', async () => {
      expect((await add({ classCategoryId: missing })).status).toBe(404);
      expect((await add({ designationId: missing })).status).toBe(404);
      const hidden = newId();
      await insertDesignation(hidden, `Hidden post ${hidden}`, 900, 0);
      const res = await add({ designationId: hidden });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('REFERENCE_INACTIVE');
      const wrong = await add({ address: { stateId: place.stateId } });
      expect(wrong.status).toBe(400);
      expect(wrong.body.errors).toEqual([
        expect.objectContaining({ field: 'address.countryId', code: 'REQUIRED' }),
      ]);
    });

    it('takes a Ready staff photo of the Institution and refuses one that is not', async () => {
      const photo = await readyPhoto();
      const staff = await added({ photoFileId: photo });
      expect(staff.photoFileId).toBe(photo);
      // A photo belongs to one person.
      expect((await add({ photoFileId: photo })).status).toBe(400);
      for (const bad of [await readyPhoto(first, 4, 1), await readyPhoto(first, 3, 2)]) {
        const res = await add({ photoFileId: bad });
        expect(res.status).toBe(400);
        expect(res.body.errors).toEqual([
          expect.objectContaining({ field: 'photoFileId', code: 'INVALID_VALUE' }),
        ]);
      }
      // A file of another Institution is not visible to a request narrowed to this one, like one that is missing.
      expect((await add({ photoFileId: await readyPhoto(second, 4, 2) })).status).toBe(404);
      expect((await add({ photoFileId: missing })).status).toBe(404);
    });
  });

  describe('who may', () => {
    it('lets an Institution Admin add and read at their own Institution only', async () => {
      const mine = await added({}, institutionAdmin.token);
      expect((await api('get', `/v1/staff/${mine.id}`, institutionAdmin.token)).status).toBe(200);
      expect((await add({ homeInstitutionId: second }, institutionAdmin.token)).status).toBe(404);
      const elsewhere = await added({ homeInstitutionId: second });
      for (const [method, body] of [
        ['get'],
        ['patch', { version: 1, firstName: 'X' }],
        ['delete'],
      ] as const) {
        const res = await api(method, `/v1/staff/${elsewhere.id}`, institutionAdmin.token, body);
        expect({ method, status: res.status }).toMatchObject({ status: 404 });
        expect(res.body.code).toBe('NOT_FOUND');
      }
      // The Owner reaches both.
      expect((await api('get', `/v1/staff/${elsewhere.id}`, owner.token)).status).toBe(200);
    });

    it('hides a record from another Society, and a record that does not exist, as 404', async () => {
      const staff = await added();
      for (const method of ['get', 'delete'] as const) {
        expect((await api(method, `/v1/staff/${staff.id}`, otherOwner.token)).status).toBe(404);
        expect((await api(method, `/v1/staff/${missing}`, owner.token)).status).toBe(404);
      }
      expect((await add({}, otherOwner.token)).status).toBe(404);
      expect((await api('get', '/v1/staff/not-an-id', owner.token)).status).toBe(404);
    });

    it('refuses Super Admin with 403 for now: the platform view of people is not built', async () => {
      expect((await add({}, admin)).status).toBe(403);
      const staff = await added();
      expect((await api('get', `/v1/staff/${staff.id}`, admin)).status).toBe(403);
    });

    it('stops an Institution Admin whose Institution has its staff blocked with 423, and not the Owner', async () => {
      const staff = await added();
      await blocks.setBlock(ownerDb, societyA, first, 2, true);
      expect((await api('get', `/v1/staff/${staff.id}`, institutionAdmin.token)).status).toBe(423);
      expect((await api('get', `/v1/staff/${staff.id}`, owner.token)).status).toBe(200);
    });
  });

  describe('STF-04 edit', () => {
    it('changes what was sent, moves the version and keeps who changed it; the audit entry holds before and after', async () => {
      const staff = await added({ employeeCode: 'EMP-1', joiningDate: '2024-06-03' });
      const res = await api('patch', `/v1/staff/${staff.id}`, institutionAdmin.token, {
        version: 1,
        firstName: 'Meena',
        lastName: null,
        employeeCode: 'EMP-2',
        mobile: { countryCode: '91', number: '9876500099' },
        employmentType: 3,
        address: { line1: '9 Hill Road', ...place },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        version: 2,
        firstName: 'Meena',
        lastName: null,
        employeeCode: 'EMP-2',
        mobile: { number: '9876500099' },
        joiningDate: '2024-06-03',
        address: { line1: '9 Hill Road', ...place },
        createdBy: { id: owner.person },
        updatedBy: { id: institutionAdmin.person },
      });
      const entries = (await audit(staff.id)).filter((e) => e.action === 'staff.updated');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor_user_id: institutionAdmin.person,
        institution_id: first,
        old_values: { firstName: 'Meera', lastName: 'Iyer', employeeCode: 'EMP-1' },
        new_values: {
          firstName: 'Meena',
          lastName: null,
          employeeCode: 'EMP-2',
          mobile: '******0099',
        },
      });
    });

    it('writes nothing when nothing changes: same version, no audit entry', async () => {
      const staff = await added({
        educations: [{ degree: 'B.Ed', yearOfPassing: 2014 }],
        emergencyContacts: [
          {
            contactName: 'Ravi',
            phone: { countryCode: '91', number: '9876500003' },
            isPrimary: true,
          },
        ],
      });
      const res = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 1,
        firstName: 'Meera',
        educations: [{ degree: 'B.Ed', yearOfPassing: 2014 }],
        emergencyContacts: [
          {
            contactName: 'Ravi',
            phone: { countryCode: '91', number: '9876500003' },
            isPrimary: true,
          },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(1);
      expect((await audit(staff.id)).map((e) => e.action)).toEqual(['staff.created']);
    });

    it('replaces the lists whole, and clears one with an empty list', async () => {
      const staff = await added({
        educations: [{ degree: 'B.Ed' }, { degree: 'M.Ed' }],
        emergencyContacts: [
          {
            contactName: 'Ravi',
            phone: { countryCode: '91', number: '9876500003' },
            isPrimary: true,
          },
        ],
      });
      const res = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 1,
        educations: [{ degree: 'Ph.D', yearOfPassing: 2020 }],
        emergencyContacts: [],
      });
      expect(res.status).toBe(200);
      const data = res.body.data as unknown as StaffData;
      expect(data.version).toBe(2);
      expect(data.educations.map((e) => e.degree)).toEqual(['Ph.D']);
      expect(data.emergencyContacts).toEqual([]);
      // A list that is not sent stays.
      const again = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 2,
        nationality: 'Indian',
      });
      expect((again.body.data as unknown as StaffData).educations).toHaveLength(1);
    });

    it('answers 409 VERSION_CONFLICT for a stale version, before anything else is looked at', async () => {
      const staff = await added();
      await api('patch', `/v1/staff/${staff.id}`, owner.token, { version: 1, firstName: 'Meena' });
      const stale = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 1,
        firstName: 'Mina',
        classCategoryId: missing,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
    });

    it('checks the rules against the stored values: a resignation before the stored joining date, a taken Employee ID', async () => {
      const staff = await added({ joiningDate: '2024-06-03', employeeCode: 'EMP-1' });
      await added({ employeeCode: 'EMP-2' });
      const early = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 1,
        resignationDate: '2024-01-01',
      });
      expect(early.status).toBe(400);
      expect(early.body.errors).toEqual([expect.objectContaining({ field: 'resignationDate' })]);
      const clash = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 1,
        employeeCode: 'emp-2',
      });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('EMPLOYEE_ID_TAKEN');
    });

    it('leaves a link alone that it does not touch, even if the master entry was hidden since, and checks a new one', async () => {
      const hidden = newId();
      await insertDesignation(hidden, `Soon hidden ${hidden}`, 901, 1);
      const staff = await added({ designationId: hidden });
      await setDesignationStatus(hidden, 0);
      expect(
        (
          await api('patch', `/v1/staff/${staff.id}`, owner.token, {
            version: 1,
            nationality: 'Indian',
          })
        ).status,
      ).toBe(200);
      const other = await added();
      const res = await api('patch', `/v1/staff/${other.id}`, owner.token, {
        version: 1,
        designationId: hidden,
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('REFERENCE_INACTIVE');
      // Clearing the link is always allowed.
      expect(
        (
          await api('patch', `/v1/staff/${staff.id}`, owner.token, {
            version: 2,
            designationId: null,
          })
        ).status,
      ).toBe(200);
    });

    it('does not let the email or the home Institution change here, and refuses null for what must have a value', async () => {
      const staff = await added();
      for (const body of [
        { version: 1, email: email() },
        { version: 1, homeInstitutionId: second },
        { version: 1, firstName: null },
        { version: 1, mobile: null },
        { version: 1, classCategoryId: null },
        { firstName: 'X' },
      ]) {
        const res = await api('patch', `/v1/staff/${staff.id}`, owner.token, body);
        expect({ body, status: res.status }).toMatchObject({ status: 400 });
      }
    });

    it('answers 404 for a deactivated staff member', async () => {
      const staff = await added();
      await api('delete', `/v1/staff/${staff.id}`, owner.token);
      expect(
        (await api('patch', `/v1/staff/${staff.id}`, owner.token, { version: 2, firstName: 'X' }))
          .status,
      ).toBe(404);
    });
  });

  describe('STF-05 deactivate', () => {
    it('deactivates, keeps the record readable for its history, and ends their sessions as staff in this Society only', async () => {
      const staff = await added();
      const session = (activeRole: number, society: string) =>
        sql<{ id: string }>`
          insert into auth_sessions (user_id, client_type, active_role_code, active_society_id, idle_expires_at, absolute_expires_at)
          values (${staff.person.id}, 1, ${activeRole}, ${society}, now() + interval '1 hour', now() + interval '1 hour')
          returning id
        `
          .execute(ownerDb)
          .then((r) => r.rows[0]!.id);
      const staffSession = await session(4, societyA);
      const parentSession = await session(5, societyA);
      const otherSociety = await session(4, otherOwner.contexts[0]!.societyId!);

      const res = await api('delete', `/v1/staff/${staff.id}`, institutionAdmin.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: staff.id, status: 0 });

      const { rows } = await sql<{ id: string; ended_at: Date | null; end_reason: number | null }>`
        select id, ended_at, end_reason from auth_sessions where user_id = ${staff.person.id}
      `.execute(ownerDb);
      const ended = new Map(rows.map((row) => [row.id, row]));
      expect(ended.get(staffSession)?.ended_at).not.toBeNull();
      expect(ended.get(staffSession)?.end_reason).toBe(4);
      expect(ended.get(parentSession)?.ended_at).toBeNull();
      expect(ended.get(otherSociety)?.ended_at).toBeNull();

      const read = await api('get', `/v1/staff/${staff.id}`, owner.token);
      expect(read.body.data).toMatchObject({ status: 0, version: 2 });
      const entry = (await audit(staff.id)).find((e) => e.action === 'staff.deactivated');
      expect(entry).toMatchObject({
        actor_user_id: institutionAdmin.person,
        institution_id: first,
      });
      expect(entry?.new_values).toMatchObject({ status: 0, sessionsEnded: 1 });
    });

    it('answers 404 the second time, and 409 CANNOT_ACT_ON_SELF for the caller’s own record', async () => {
      const staff = await added();
      expect((await api('delete', `/v1/staff/${staff.id}`, owner.token)).status).toBe(200);
      expect((await api('delete', `/v1/staff/${staff.id}`, owner.token)).status).toBe(404);
      const mine = await added({ email: institutionAdmin.email }, owner.token);
      const self = await api('delete', `/v1/staff/${mine.id}`, institutionAdmin.token);
      expect(self.status).toBe(409);
      expect(self.body.code).toBe('CANNOT_ACT_ON_SELF');
    });
  });

  describe('the staff record and the section blocks (migration 0024)', () => {
    it('answers for a person who holds only an active staff record: a blocked teacher is stopped, and told the Society', async () => {
      const staff = await added();
      await blocks.setBlock(ownerDb, societyA, first, 2, true);
      expect(await activeBlocksOf(ownerDb, societyA, staff.person.id)).toEqual([
        { section: 2, institution_id: first },
      ]);
      const { rows } = await sql<{
        name: string | null;
      }>`select app_society_name(${societyA}, ${staff.person.id}) as name`.execute(ownerDb);
      expect(rows[0]?.name).toBe('Sunrise Trust');
      // Another Society's blocks, and a person with no record or grant here, are not shown.
      expect(await activeBlocksOf(ownerDb, await makeSociety(), staff.person.id)).toEqual([]);
      expect(await activeBlocksOf(ownerDb, societyA, newId())).toEqual([]);
    });

    it('stops answering once the staff record is deactivated', async () => {
      const staff = await added();
      await blocks.setBlock(ownerDb, societyA, first, 2, true);
      await api('delete', `/v1/staff/${staff.id}`, owner.token);
      expect(await activeBlocksOf(ownerDb, societyA, staff.person.id)).toEqual([]);
    });
  });

  describe('the staff tables', () => {
    it('are hidden from another Society by row-level security, and cannot be deleted by the app role', async () => {
      const staff = await added({
        educations: [{ degree: 'B.Ed' }],
        emergencyContacts: [
          {
            contactName: 'Ravi',
            phone: { countryCode: '91', number: '9876500003' },
            isPrimary: true,
          },
        ],
      });
      const otherSociety = otherOwner.contexts[0]!.societyId!;
      for (const table of [
        'staff_members',
        'staff_educations',
        'staff_emergency_contacts',
      ] as const) {
        const rows = await database.transaction({ societyId: otherSociety }, (tx) =>
          tx.selectFrom(table).selectAll().execute(),
        );
        expect(rows).toEqual([]);
        const mine = await database.transaction({ societyId: societyA }, (tx) =>
          tx.selectFrom(table).selectAll().execute(),
        );
        expect(mine.length).toBeGreaterThan(0);
      }
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`delete from staff_members where id = ${staff.id}`.execute(tx),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`update staff_educations set degree = 'x' where staff_member_id = ${staff.id}`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('refuse what the checks forbid even if the API let it through: two primary contacts, a resignation before the joining', async () => {
      const staff = await added();
      const contact = (primary: boolean) =>
        database.transaction({ societyId: societyA }, (tx) =>
          sql`insert into staff_emergency_contacts (society_id, staff_member_id, contact_name, country_code, phone_number, is_primary)
            values (${societyA}, ${staff.id}, 'X', '91', '9876500003', ${primary})`.execute(tx),
        );
      await contact(true);
      await expect(contact(true)).rejects.toMatchObject({
        constraint: 'uq_staff_emergency_contacts_primary',
      });
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`update staff_members set joining_date = '2024-06-03', resignation_date = '2024-06-02' where id = ${staff.id}`.execute(
            tx,
          ),
        ),
      ).rejects.toMatchObject({ constraint: 'ck_staff_members_resignation' });
    });
  });
});
