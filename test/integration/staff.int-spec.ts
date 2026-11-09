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
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

const namesOf = (res: { body: { data: unknown } }) =>
  (res.body.data as unknown as { firstName: string }[]).map((row) => row.firstName);

const email = () => `${newId()}@staff.test`;

const activeBlocksOf = async (db: Kysely<unknown>, society: string, person: string) => {
  const { rows } = await sql<{ section: number; institution_id: string | null }>`
    select * from app_active_blocks(${society}, ${person})
  `.execute(db);
  return rows;
};

/** The settings an Owner's tenant transaction of this Society carries. */
const settingsOf = (tenant: { societyId: string; personId: string }) => ({
  role: '2',
  society: tenant.societyId,
  person: tenant.personId,
});

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

  const change = (id: string, token: string, fields: object) =>
    api('put', `/v1/staff/${id}/email`, token, fields);
  const emailOf = (person: string) =>
    sql<{ email: string }>`select email from users where id = ${person}`
      .execute(ownerDb)
      .then((r) => r.rows[0]?.email);
  const accountOf = async (address: string) =>
    (await sql<{ id: string }>`select id from users where email = ${address}`.execute(ownerDb))
      .rows[0]?.id;
  const staffOf = (token: string, institution: string, address: string) =>
    api('post', '/v1/staff', token, {
      homeInstitutionId: institution,
      email: address,
      firstName: 'Meera',
      classCategoryId: categoryId,
      mobile: { countryCode: '91', number: '9876500001' },
    });

  /** Society B with an Owner and one Institution, for a person who is staff or Owner in two Societies. */
  const secondSociety = async () => {
    const society = await makeSociety();
    const ownerOfB = await fixtures.owner(society);
    const institution = await makeInstitution(ownerOfB.token);
    return { society, ownerOfB, institution };
  };

  /** `app_has_staff_elsewhere` as a tenant of this Society, with the settings the transaction ends with. */
  const asked = (
    tenant: { societyId: string; personId: string },
    person: string,
    homeSociety: string,
  ) =>
    database.transaction(
      { societyId: tenant.societyId, roleCode: 2, personId: tenant.personId },
      async (tx) => {
        const found = await sql<{
          held: boolean;
        }>`select app_has_staff_elsewhere(${person}::uuid, ${homeSociety}::uuid) as held`.execute(
          tx,
        );
        const settings = await sql<{ role: string; society: string; person: string }>`
            select current_setting('app.role_code') as role, current_setting('app.society_id') as society,
              current_setting('app.person_id') as person`.execute(tx);
        return { held: found.rows[0]?.held, settings: settings.rows[0] };
      },
    );

  const personOf = (res: { body: { data: unknown } }) => (res.body.data as StaffData).person;

  const list = (token: string, query = '') => api('get', `/v1/staff${query}`, token);
  /** Four people in two Institutions: Zara and Asha at the first, Meera and Dev at the second. */
  const team = async () => {
    const zara = await added({ firstName: 'Zara', lastName: 'Khan', employeeCode: 'T-300' });
    const asha = await added({ firstName: 'Asha', lastName: 'Bose', employeeCode: 'T-100' });
    const meera = await added({
      homeInstitutionId: second,
      firstName: 'Meera',
      lastName: 'Iyer',
      employeeCode: 'T-200',
      designationId,
    });
    const dev = await added({ homeInstitutionId: second, firstName: 'Dev', lastName: null });
    return { zara, asha, meera, dev };
  };

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
  /**
   * After the Societies are gone, so no staff record still points at them. The table has no delete policy (a master
   * is hidden, never deleted), so the owner lifts the forced policy for this one transaction, as the audit helper does.
   */
  const removeScratchDesignations = async () => {
    const ids = scratchDesignations.splice(0);
    if (ids.length === 0) return;
    await ownerDb.transaction().execute(async (trx) => {
      await sql`alter table designations no force row level security`.execute(trx);
      await sql`delete from designations where id = any(${sql.val(ids)}::uuid[])`.execute(trx);
      await sql`alter table designations force row level security`.execute(trx);
    });
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

    it('saves an edit that changes only a contact’s primary flag, or only an education’s year', async () => {
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
      const flipped = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 1,
        emergencyContacts: [
          {
            contactName: 'Ravi',
            phone: { countryCode: '91', number: '9876500003' },
            isPrimary: false,
          },
        ],
      });
      expect(flipped.status).toBe(200);
      const afterFlip = flipped.body.data as unknown as StaffData;
      expect(afterFlip.version).toBe(2);
      expect(afterFlip.emergencyContacts.map((c) => c.isPrimary)).toEqual([false]);
      const later = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 2,
        educations: [{ degree: 'B.Ed', yearOfPassing: 2015 }],
      });
      expect(later.status).toBe(200);
      const afterYear = later.body.data as unknown as StaffData;
      expect(afterYear.version).toBe(3);
      expect(afterYear.educations.map((e) => e.yearOfPassing)).toEqual([2015]);
    });

    it('checks the place and the photo of an edit as it does of an add', async () => {
      const staff = await added({ address: place });
      const { rows } = await sql<{ id: string }>`
        select id from cities where status = 1 and state_id <> ${place.stateId} limit 1
      `.execute(ownerDb);
      const elsewhere = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 1,
        address: { cityId: rows[0]!.id },
      });
      expect(elsewhere.status).toBe(400);
      expect(elsewhere.body.errors?.[0]?.field).toMatch(/^address/);
      for (const bad of [await readyPhoto(first, 4, 1), await readyPhoto(first, 3, 2)]) {
        const res = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
          version: 1,
          photoFileId: bad,
        });
        expect(res.status).toBe(400);
        expect(res.body.errors).toEqual([
          expect.objectContaining({ field: 'photoFileId', code: 'INVALID_VALUE' }),
        ]);
      }
      // Another Institution's file is not visible to a request narrowed to this one, as on an add.
      const hidden = await api('patch', `/v1/staff/${staff.id}`, owner.token, {
        version: 1,
        photoFileId: await readyPhoto(second, 4, 2),
      });
      expect(hidden.status).toBe(404);
      // Nothing was written by the refusals.
      expect(
        ((await api('get', `/v1/staff/${staff.id}`, owner.token)).body.data as unknown as StaffData)
          .version,
      ).toBe(1);
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

  describe('STF-01 list', () => {
    it('lists every active staff member of the Society, by name, with the summary fields and the page meta', async () => {
      const { asha } = await team();
      const res = await list(owner.token);
      expect(res.status).toBe(200);
      expect(namesOf(res)).toEqual(['Asha', 'Dev', 'Meera', 'Zara']);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, totalItems: 4, totalPages: 1 });
      expect((res.body.data as unknown as unknown[])[0]).toEqual({
        id: asha.id,
        homeInstitutionId: first,
        person: asha.person,
        employeeCode: 'T-100',
        firstName: 'Asha',
        lastName: 'Bose',
        photoFileId: null,
        designationId: null,
        classCategoryId: categoryId,
        mobile: { countryCode: '91', number: '9876500001' },
        joiningDate: null,
        status: 1,
        version: 1,
      });
      expect(Object.keys((res.body.data as unknown as object[])[0]!)).not.toContain('educations');
    });

    it('lists active staff unless a status is asked for, and keeps a deactivated one for its history', async () => {
      const { zara } = await team();
      expect((await api('delete', `/v1/staff/${zara.id}`, owner.token)).status).toBe(200);
      expect(namesOf(await list(owner.token))).toEqual(['Asha', 'Dev', 'Meera']);
      expect(namesOf(await list(owner.token, '?status=0'))).toEqual(['Zara']);
      expect(namesOf(await list(owner.token, '?status=0&status=1'))).toEqual([
        'Asha',
        'Dev',
        'Meera',
        'Zara',
      ]);
      expect((await list(owner.token, '?status=2')).status).toBe(400);
    });

    it('searches by name or Employee ID, without regard to case, and takes % and _ literally', async () => {
      await team();
      expect(namesOf(await list(owner.token, '?q=zar'))).toEqual(['Zara']);
      expect(namesOf(await list(owner.token, '?q=IYER'))).toEqual(['Meera']);
      expect(namesOf(await list(owner.token, '?q=Asha%20Bose'))).toEqual(['Asha']);
      expect(namesOf(await list(owner.token, '?q=t-2'))).toEqual(['Meera']);
      expect(namesOf(await list(owner.token, '?q=T-'))).toEqual(['Asha', 'Meera', 'Zara']);
      expect(namesOf(await list(owner.token, '?q=%25_'))).toEqual([]);
      const none = await list(owner.token, '?q=nobody');
      expect(none.body).toMatchObject({ data: [], meta: { totalItems: 0, totalPages: 0 } });
      expect((await list(owner.token, '?q=a')).status).toBe(400);
    });

    it('filters by Institution, designation and class category', async () => {
      await team();
      expect(namesOf(await list(owner.token, `?institutionId=${second}`))).toEqual([
        'Dev',
        'Meera',
      ]);
      expect(namesOf(await list(owner.token, `?designationId=${designationId}`))).toEqual([
        'Meera',
      ]);
      expect(namesOf(await list(owner.token, `?classCategoryId=${categoryId}`))).toHaveLength(4);
      expect(namesOf(await list(owner.token, `?classCategoryId=${missing}`))).toEqual([]);
      expect((await list(owner.token, '?institutionId=nope')).status).toBe(400);
    });

    it('sorts by the allowed fields, adds the ID last, and pages without repeating or skipping', async () => {
      await team();
      expect(namesOf(await list(owner.token, '?sort=-name'))).toEqual([
        'Zara',
        'Meera',
        'Dev',
        'Asha',
      ]);
      // A member without an Employee ID sorts last in either direction.
      expect(namesOf(await list(owner.token, '?sort=employeeCode'))).toEqual([
        'Asha',
        'Meera',
        'Zara',
        'Dev',
      ]);
      expect(namesOf(await list(owner.token, '?sort=-employeeCode'))).toEqual([
        'Zara',
        'Meera',
        'Asha',
        'Dev',
      ]);
      const pages = [
        namesOf(await list(owner.token, '?limit=3&page=1')),
        namesOf(await list(owner.token, '?limit=3&page=2')),
      ];
      expect(pages).toEqual([['Asha', 'Dev', 'Meera'], ['Zara']]);
      const past = await list(owner.token, '?limit=3&page=9');
      expect(past.body).toMatchObject({
        data: [],
        meta: { page: 9, totalItems: 4, totalPages: 2 },
      });
      expect((await list(owner.token, '?sort=salary')).status).toBe(400);
      expect((await list(owner.token, '?limit=101')).status).toBe(400);
    });

    it('shows an Institution Admin their own Institution’s staff only, and 404 for another', async () => {
      await team();
      expect(namesOf(await list(institutionAdmin.token))).toEqual(['Asha', 'Zara']);
      expect((await list(institutionAdmin.token, `?institutionId=${second}`)).status).toBe(404);
      expect(namesOf(await list(institutionAdmin.token, `?institutionId=${first}`))).toEqual([
        'Asha',
        'Zara',
      ]);
    });

    it('shows nothing of another Society, and 404 for its Institution', async () => {
      await team();
      const res = await list(otherOwner.token);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ data: [], meta: { totalItems: 0 } });
      expect((await list(otherOwner.token, `?institutionId=${first}`)).status).toBe(404);
    });

    it('is for admins: a teacher and the Super Admin’s platform token get 403', async () => {
      const { asha } = await team();
      const teacher = await signInMobile(t, asha.person.email);
      expect((await list(teacher.accessToken)).status).toBe(403);
      expect((await list(admin)).status).toBe(403);
    });

    it('stops an Institution Admin whose Institution has its staff blocked, and not the Owner', async () => {
      await team();
      await blocks.setBlock(ownerDb, societyA, first, 2, true);
      const stopped = await list(institutionAdmin.token);
      expect(stopped.status).toBe(423);
      expect(stopped.body.code).toBe('SECTION_BLOCKED');
      expect(namesOf(await list(owner.token))).toEqual(['Asha', 'Dev', 'Meera', 'Zara']);
    });
  });

  describe('STF-13 change the login email', () => {
    it('changes the email of a person who holds only this record: same person, sessions ended, both addresses told, audited masked', async () => {
      const staff = await added();
      const { accessToken } = await signInMobile(t, staff.person.email);
      expect((await api('get', `/v1/staff/${staff.id}`, accessToken)).status).toBe(200);
      const to = `z${email()}`.toUpperCase();

      const res = await change(staff.id, institutionAdmin.token, { email: to, version: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: staff.id,
        version: 2,
        person: { id: staff.person.id, email: to.toLowerCase() },
        updatedBy: { id: institutionAdmin.person },
      });
      expect(await emailOf(staff.person.id)).toBe(to.toLowerCase());
      // The session the old email opened ends at once.
      expect((await api('get', `/v1/staff/${staff.id}`, accessToken)).status).toBe(401);
      expect(t.email.latest(staff.person.email, 'email-changed-old')?.text).toContain(
        'your school',
      );
      expect(t.email.latest(to.toLowerCase(), 'email-changed-new')).toBeDefined();
      // The new address signs in as the same teacher.
      const login = await signInMobile(t, to.toLowerCase());
      expect(login.contexts).toEqual([
        expect.objectContaining({ roleCode: 4, societyId: societyA }),
      ]);

      const entry = (await audit(staff.id)).find((e) => e.action === 'staff.email_changed');
      expect(entry).toMatchObject({
        actor_user_id: institutionAdmin.person,
        institution_id: first,
        old_values: { email: `${staff.person.email.slice(0, 1)}***@staff.test` },
        new_values: { email: 'z***@staff.test', outcome: 'edited' },
      });
      expect(JSON.stringify(entry)).not.toContain(staff.person.email);
      expect(JSON.stringify(entry)).not.toContain(to.toLowerCase());
    });

    it('writes nothing for the email the person already has, whatever its case', async () => {
      const staff = await added();
      const { accessToken } = await signInMobile(t, staff.person.email);
      const res = await change(staff.id, owner.token, {
        email: staff.person.email.toUpperCase(),
        version: 1,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ version: 1, person: { email: staff.person.email } });
      expect((await api('get', `/v1/staff/${staff.id}`, accessToken)).status).toBe(200);
      expect((await audit(staff.id)).some((e) => e.action === 'staff.email_changed')).toBe(false);
      expect(t.email.latest(staff.person.email, 'email-changed-old')).toBeUndefined();
    });

    it('moves the record to the person the email belongs to, and leaves the old account as it was', async () => {
      const staff = await added();
      const { accessToken } = await signInMobile(t, staff.person.email);
      const other = await fixtures.institutionAdmin(societyA, [second]);

      const res = await change(staff.id, owner.token, {
        email: other.email.toUpperCase(),
        version: 1,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: staff.id,
        version: 2,
        person: { id: other.person, email: other.email },
      });
      expect(await emailOf(staff.person.id)).toBe(staff.person.email);
      expect((await api('get', `/v1/staff/${staff.id}`, accessToken)).status).toBe(401);
      expect((await signInMobile(t, staff.person.email)).contexts).toEqual([]);
      const moved = await signInMobile(t, other.email);
      expect(moved.contexts.map((c) => c.roleCode).toSorted()).toEqual([3, 4]);
      expect(t.email.latest(staff.person.email, 'staff-access-moved')).toBeDefined();
      expect(t.email.latest(other.email, 'welcome')?.variables).toMatchObject({ role: 'Teacher' });
      const entry = (await audit(staff.id)).find((e) => e.action === 'staff.email_changed');
      expect(entry?.new_values).toMatchObject({ outcome: 'moved', personId: other.person });
    });

    it('does not change the email of a person who holds more: the record moves to a new person and the Owner keeps their login', async () => {
      const staff = await added({ email: owner.email });
      expect(staff.person.id).toBe(owner.person);
      const to = email();
      const res = await change(staff.id, institutionAdmin.token, { email: to, version: 1 });
      expect(res.status).toBe(200);
      expect(personOf(res).email).toBe(to);
      expect(personOf(res).id).not.toBe(owner.person);
      staffUsers.push(personOf(res).id);
      expect(await emailOf(owner.person)).toBe(owner.email);
      const ownerLogin = await signInMobile(t, owner.email);
      expect(ownerLogin.contexts.map((c) => c.roleCode)).toEqual([2]);
      const created = await signInMobile(t, to);
      expect(created.contexts).toEqual([expect.objectContaining({ roleCode: 4 })]);
      const { rows } = await sql<{ first_name: string | null; account_status: number }>`
        select first_name, account_status from users where email = ${to}`.execute(ownerDb);
      expect(rows[0]).toEqual({ first_name: 'Meera', account_status: 1 });
    });

    it('does not change the email of a person who is staff in another Society too', async () => {
      const staff = await added();
      const elsewhere = await api('post', '/v1/institutions', otherOwner.token, {
        name: 'Hill School',
        code: `I${newId().slice(-10)}`,
        address: { line1: '1 Hill Road' },
      });
      await api('post', '/v1/staff', otherOwner.token, {
        homeInstitutionId: elsewhere.body.data.id,
        email: staff.person.email,
        firstName: 'Meera',
        classCategoryId: categoryId,
        mobile: { countryCode: '91', number: '9876500001' },
      });
      const to = email();
      const res = await change(staff.id, owner.token, { email: to, version: 1 });
      expect(res.status).toBe(200);
      staffUsers.push(personOf(res).id);
      expect(personOf(res).id).not.toBe(staff.person.id);
      expect(await emailOf(staff.person.id)).toBe(staff.person.email);
    });

    it('counts a record in a deactivated Institution of another Society as held: the record moves to a new person', async () => {
      const staff = await added();
      const { ownerOfB, institution } = await secondSociety();
      expect((await staffOf(ownerOfB.token, institution, staff.person.email)).status).toBe(201);
      expect((await api('delete', `/v1/institutions/${institution}`, ownerOfB.token)).status).toBe(
        200,
      );

      const to = email();
      const res = await change(staff.id, owner.token, { email: to, version: 1 });
      expect(res.status).toBe(200);
      staffUsers.push(personOf(res).id);
      expect(personOf(res).id).not.toBe(staff.person.id);
      expect(await emailOf(staff.person.id)).toBe(staff.person.email);
    });

    it('answers the staff-elsewhere lookup only for the person asked about, from a tenant transaction of any Society, and puts the settings back', async () => {
      const staff = await added();
      const { society: societyB, ownerOfB, institution } = await secondSociety();
      const inB = await staffOf(ownerOfB.token, institution, staff.person.email);
      expect(inB.status).toBe(201);

      const fromA = { societyId: societyA, personId: owner.person };
      const fromB = { societyId: societyB, personId: ownerOfB.person };
      // The record in B counts from the home Society's tenant, and from a tenant of a Society that is not the home one.
      expect(await asked(fromA, staff.person.id, societyA)).toEqual({
        held: true,
        settings: settingsOf(fromA),
      });
      expect(await asked(fromB, staff.person.id, societyA)).toEqual({
        held: true,
        settings: settingsOf(fromB),
      });
      // Only the person asked about: the Owner of A and a stranger hold no record in B, though B has one.
      expect((await asked(fromB, owner.person, societyA)).held).toBe(false);
      expect((await asked(fromB, newId(), societyA)).held).toBe(false);
      expect(await asked(fromA, owner.person, societyA)).toEqual({
        held: false,
        settings: settingsOf(fromA),
      });
      // Asked from the other side the record in A is the one elsewhere. Once B's record has ended, the one in the
      // home Society itself does not count, and neither does the ended one.
      expect((await asked(fromA, staff.person.id, societyB)).held).toBe(true);
      expect((await asked(fromB, staff.person.id, societyB)).held).toBe(true);
      const inBId = (inB.body.data as unknown as StaffData).id;
      expect((await api('delete', `/v1/staff/${inBId}`, ownerOfB.token)).status).toBe(200);
      expect(await asked(fromA, staff.person.id, societyA)).toEqual({
        held: false,
        settings: settingsOf(fromA),
      });
    });

    it('counts an Owner grant revoked by a deactivated Society as held: the record moves to a new person', async () => {
      const { society, ownerOfB } = await secondSociety();
      const staff = await added({ email: ownerOfB.email });
      expect(staff.person.id).toBe(ownerOfB.person);
      expect((await api('delete', `/v1/platform/societies/${society}`, admin)).status).toBe(200);

      const to = email();
      const res = await change(staff.id, owner.token, { email: to, version: 1 });
      expect(res.status).toBe(200);
      staffUsers.push(personOf(res).id);
      expect(personOf(res).id).not.toBe(ownerOfB.person);
      expect(await emailOf(ownerOfB.person)).toBe(ownerOfB.email);
    });

    it('counts an Institution Admin grant as held: the record moves to a new person and the Admin keeps their login', async () => {
      const adminOfSecond = await fixtures.institutionAdmin(societyA, [second]);
      const staff = await added({ email: adminOfSecond.email, homeInstitutionId: first });
      expect(staff.person.id).toBe(adminOfSecond.person);
      const to = email();
      const res = await change(staff.id, institutionAdmin.token, { email: to, version: 1 });
      expect(res.status).toBe(200);
      staffUsers.push(personOf(res).id);
      expect(personOf(res).id).not.toBe(adminOfSecond.person);
      expect(await emailOf(adminOfSecond.person)).toBe(adminOfSecond.email);
      expect((await signInMobile(t, adminOfSecond.email)).contexts.map((c) => c.roleCode)).toEqual([
        3,
      ]);
    });

    it('waits for an email change in flight, so a record added at the old address does not land on the person at the new one', async () => {
      const staff = await added();
      const { ownerOfB, institution } = await secondSociety();
      const moved = email();
      let request: ReturnType<typeof staffOf> | undefined;
      let settled = false;
      await ownerDb.transaction().execute(async (trx) => {
        // What an email change holds first: the platform-wide identity lock.
        await sql`select pg_advisory_xact_lock(hashtextextended('grants:role-separation', 0))`.execute(
          trx,
        );
        await sql`update users set email = ${moved} where id = ${staff.person.id}`.execute(trx);
        request = staffOf(ownerOfB.token, institution, staff.person.email);
        void request.then(() => {
          settled = true;
          return true;
        });
        await new Promise((resolve) => setTimeout(resolve, 700));
        // The change is written but not committed: the add has to wait for it.
        expect(settled).toBe(false);
      });
      const res = await request!;
      expect(res.status).toBe(201);
      staffUsers.push(personOf(res).id);
      // Nobody was at the old address any more, so a new person was made there.
      expect(personOf(res)).toMatchObject({ email: staff.person.email });
      expect(personOf(res).id).not.toBe(staff.person.id);
      expect(await emailOf(staff.person.id)).toBe(moved);
    });

    it('waits for the person’s row when another change holds it, before it looks at what they hold', async () => {
      const staff = await added();
      let request: ReturnType<typeof change> | undefined;
      let settled = false;
      await ownerDb.transaction().execute(async (trx) => {
        await sql`select 1 from users where id = ${staff.person.id} for update`.execute(trx);
        // The same email writes nothing, so only the lock can make this wait.
        request = change(staff.id, owner.token, { email: staff.person.email, version: 1 });
        void request.then(() => {
          settled = true;
          return true;
        });
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(settled).toBe(false);
      });
      expect((await request!).status).toBe(200);
    });

    it('refuses to move a record onto the caller', async () => {
      const staff = await added();
      const res = await change(staff.id, institutionAdmin.token, {
        email: institutionAdmin.email,
        version: 1,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CANNOT_ACT_ON_SELF');
      expect(personOf(await api('get', `/v1/staff/${staff.id}`, owner.token)).id).toBe(
        staff.person.id,
      );
    });

    it('refuses an email whose person already has a record in this Society, and changes nothing', async () => {
      const staff = await added();
      const colleague = await added({ homeInstitutionId: second });
      const res = await change(staff.id, owner.token, {
        email: colleague.person.email,
        version: 1,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EMAIL_IN_USE');
      const read = await api('get', `/v1/staff/${staff.id}`, owner.token);
      expect(read.body.data).toMatchObject({ version: 1, person: { id: staff.person.id } });
    });

    it('lets a person whose record here ended take a record, and refuses a Super Admin and a blocked person', async () => {
      const staff = await added();
      const earlier = await added({ homeInstitutionId: second });
      expect((await api('delete', `/v1/staff/${earlier.id}`, owner.token)).status).toBe(200);
      const back = await change(staff.id, owner.token, { email: earlier.person.email, version: 1 });
      expect(back.status).toBe(200);
      expect(personOf(back).id).toBe(earlier.person.id);

      const again = await added();
      const conflict = await change(again.id, owner.token, { email: superAdmin.email, version: 1 });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('ROLE_CONFLICT');

      const blocked = await fixtures.institutionAdmin(societyA, [second]);
      await sql`update users set account_status = 2, blocked_at = now() where id = ${blocked.person}`.execute(
        ownerDb,
      );
      const refused = await change(again.id, owner.token, { email: blocked.email, version: 1 });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('ACCOUNT_BLOCKED');
      expect(await emailOf(again.person.id)).toBe(again.person.email);
    });

    it('checks the version, the body, the record and the caller', async () => {
      const staff = await added();
      const to = email();
      const stale = await change(staff.id, owner.token, { email: to, version: 9 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect(
        (await change(staff.id, owner.token, { email: 'not-an-email', version: 1 })).status,
      ).toBe(400);
      expect((await change(staff.id, owner.token, { version: 1 })).status).toBe(400);
      expect((await change(staff.id, owner.token, { email: to })).status).toBe(400);
      expect((await change(missing, owner.token, { email: to, version: 1 })).status).toBe(404);

      const mine = await added({ email: institutionAdmin.email }, owner.token);
      const self = await change(mine.id, institutionAdmin.token, { email: to, version: 1 });
      expect(self.status).toBe(409);
      expect(self.body.code).toBe('CANNOT_ACT_ON_SELF');

      expect((await api('delete', `/v1/staff/${staff.id}`, owner.token)).status).toBe(200);
      expect((await change(staff.id, owner.token, { email: to, version: 2 })).status).toBe(404);
    });

    it('is the home Institution’s Admin or the Society’s Owner, and nobody else', async () => {
      const homeSecond = await added({ homeInstitutionId: second });
      const to = email();
      // An Admin of the first Institution does not reach the second; another Society's Owner reaches nothing here.
      expect(
        (await change(homeSecond.id, institutionAdmin.token, { email: to, version: 1 })).status,
      ).toBe(404);
      expect(
        (await change(homeSecond.id, otherOwner.token, { email: to, version: 1 })).status,
      ).toBe(404);
      expect((await change(homeSecond.id, admin, { email: to, version: 1 })).status).toBe(403);
      const teacher = await signInMobile(t, homeSecond.person.email);
      expect(
        (await change(homeSecond.id, teacher.accessToken, { email: to, version: 1 })).status,
      ).toBe(403);
      expect(await emailOf(homeSecond.person.id)).toBe(homeSecond.person.email);
    });

    it('lets exactly one of two requests that move records to one person win', async () => {
      const a = await added();
      const b = await added({ homeInstitutionId: second });
      const target = await fixtures.institutionAdmin(societyA, [first]);
      const results = await Promise.all([
        change(a.id, owner.token, { email: target.email, version: 1 }),
        change(b.id, owner.token, { email: target.email, version: 1 }),
      ]);
      expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe('EMAIL_IN_USE');
      expect(await accountOf(target.email)).toBe(target.person);
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
      const { rows } = await sql<{
        name: string | null;
      }>`select app_society_name(${societyA}, ${staff.person.id}) as name`.execute(ownerDb);
      expect(rows[0]?.name).toBeNull();
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

    it('refuse a write that names another Society, and a move of a record to one', async () => {
      const staff = await added();
      const otherSociety = otherOwner.contexts[0]!.societyId!;
      const refused = /row-level security/;
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`insert into staff_members (society_id, home_institution_id, user_id, first_name, class_category_id, country_code, mobile_number)
            values (${otherSociety}, ${first}, ${staff.person.id}, 'X', ${categoryId}, '91', '9876500009')`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(refused);
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`insert into staff_educations (society_id, staff_member_id, degree)
            values (${otherSociety}, ${staff.id}, 'X')`.execute(tx),
        ),
      ).rejects.toThrow(refused);
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`insert into staff_emergency_contacts (society_id, staff_member_id, contact_name, country_code, phone_number)
            values (${otherSociety}, ${staff.id}, 'X', '91', '9876500003')`.execute(tx),
        ),
      ).rejects.toThrow(refused);
      await expect(
        database.transaction({ societyId: societyA }, (tx) =>
          sql`update staff_members set society_id = ${otherSociety} where id = ${staff.id}`.execute(
            tx,
          ),
        ),
      ).rejects.toThrow(refused);
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
