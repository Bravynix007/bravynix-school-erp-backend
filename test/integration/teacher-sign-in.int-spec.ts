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
import * as blocks from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;
const OWNER = 2;

/** DDD 7.2 M1, DDD 15.3: a person with an active staff record signs in as a Teacher / Staff. */
describe('the teacher signs in from the staff record', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const staffUsers: string[] = [];

  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let societyA: string;
  let first: string;
  let second: string;
  let categoryId: string;

  const refresh = (refreshToken: string) =>
    request(t.app.getHttpServer()).post('/v1/auth/refresh').send({ refreshToken });

  const makeSociety = async () => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    societies.push(res.body.data.id);
    return res.body.data.id as string;
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

  /** Adds a teacher at `institutionId` as the Owner; the staff record and its person are returned. */
  const addTeacher = async (fields: { email?: string; homeInstitutionId?: string } = {}) => {
    const res = await api('post', '/v1/staff', owner.token, {
      homeInstitutionId: first,
      email: `${newId()}@staff.test`,
      firstName: 'Meera',
      classCategoryId: categoryId,
      mobile: { countryCode: '91', number: '9876500001' },
      ...fields,
    });
    expect(res.status).toBe(201);
    const staff = res.body.data as unknown as { id: string; person: { id: string; email: string } };
    staffUsers.push(staff.person.id);
    return staff;
  };

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    fixtures = new PlatformFixtures(t, ownerDb);
    api = apiCaller(t);
    const { rows } = await sql<{ id: string }>`
      select id from class_categories where status = 1 order by display_order limit 1
    `.execute(ownerDb);
    categoryId = rows[0]!.id;
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
  });

  afterEach(async () => {
    await blocks.clearBlocks(ownerDb);
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    for (const id of staffUsers.splice(0)) {
      await sql`delete from users where id = ${id}`.execute(ownerDb);
    }
    await fixtures.cleanup();
  });

  it('lists the Teacher context with the Society’s name, and starts the session in it', async () => {
    const staff = await addTeacher();
    const login = await signInMobile(t, staff.person.email);
    expect(login.contexts).toEqual([
      { roleCode: TEACHER, societyId: societyA, societyName: 'Sunrise Trust', isBlocked: false },
    ]);
    expect(login.session.activeContext).toMatchObject({ roleCode: TEACHER, societyId: societyA });
    const me = await api('get', '/v1/me', login.accessToken);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({
      userType: TEACHER,
      session: { activeContext: { roleCode: TEACHER } },
      contexts: [{ roleCode: TEACHER, societyId: societyA }],
    });
  });

  it('lets a teacher read their own profile and their Institution, and nothing else', async () => {
    const mine = await addTeacher();
    const colleague = await addTeacher();
    const { accessToken } = await signInMobile(t, mine.person.email);

    const own = await api('get', `/v1/staff/${mine.id}`, accessToken);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ id: mine.id, homeInstitutionId: first });
    // A colleague's profile is as if it did not exist.
    expect((await api('get', `/v1/staff/${colleague.id}`, accessToken)).status).toBe(404);

    // The Institution they work at, and not the other one of the Society.
    expect((await api('get', `/v1/institutions/${first}`, accessToken)).status).toBe(200);
    expect((await api('get', `/v1/institutions/${second}`, accessToken)).status).toBe(404);

    // What an admin does stays an admin's.
    expect((await api('patch', `/v1/staff/${mine.id}`, accessToken, { version: 1 })).status).toBe(
      403,
    );
    expect((await api('delete', `/v1/staff/${mine.id}`, accessToken)).status).toBe(403);
    expect((await api('post', '/v1/staff', accessToken, {})).status).toBe(403);
  });

  it('keeps a teacher in their own Society: no other context can be chosen', async () => {
    const staff = await addTeacher();
    const { accessToken } = await signInMobile(t, staff.person.email);
    for (const body of [
      { roleCode: TEACHER, societyId: newId() },
      { roleCode: OWNER, societyId: societyA },
      { roleCode: 3, societyId: societyA },
    ]) {
      const res = await api('post', '/v1/auth/context', accessToken, body);
      expect({ body, status: res.status }).toMatchObject({ status: 403 });
    }
  });

  it('marks the context blocked while the Institution has its staff blocked, and answers 423 until it is lifted', async () => {
    const staff = await addTeacher();
    await blocks.setBlock(ownerDb, societyA, first, 2, true);
    const login = await signInMobile(t, staff.person.email);
    expect(login.contexts).toEqual([
      expect.objectContaining({ roleCode: TEACHER, isBlocked: true }),
    ]);
    const stopped = await api('get', `/v1/institutions/${first}`, login.accessToken);
    expect(stopped.status).toBe(423);
    expect(stopped.body.code).toBe('SECTION_BLOCKED');
    await blocks.setBlock(ownerDb, societyA, first, 2, false);
    expect((await api('get', `/v1/institutions/${first}`, login.accessToken)).status).toBe(200);
    // A lifted block no longer marks the context.
    const lifted = await signInMobile(t, staff.person.email);
    expect(lifted.contexts).toEqual([
      expect.objectContaining({ roleCode: TEACHER, isBlocked: false }),
    ]);
  });

  it('is not stopped by a block of the Society’s Owners, of its own Institution’s students, or of another Institution’s staff', async () => {
    const staff = await addTeacher();
    await blocks.setBlock(ownerDb, societyA, null, 1, true);
    await blocks.setBlock(ownerDb, societyA, second, 2, true);
    // A block of the Institution's students is not a block of its staff.
    await blocks.setBlock(ownerDb, societyA, first, 3, true);
    const login = await signInMobile(t, staff.person.email);
    expect(login.contexts).toEqual([
      expect.objectContaining({ roleCode: TEACHER, isBlocked: false }),
    ]);
    expect((await api('get', `/v1/staff/${staff.id}`, login.accessToken)).status).toBe(200);
    expect((await api('get', `/v1/institutions/${first}`, login.accessToken)).status).toBe(200);
  });

  it('ends the teacher’s session on the next call once the staff record is deactivated, and lists no context after', async () => {
    const staff = await addTeacher();
    const { accessToken } = await signInMobile(t, staff.person.email);
    expect((await api('get', `/v1/staff/${staff.id}`, accessToken)).status).toBe(200);
    expect((await api('delete', `/v1/staff/${staff.id}`, institutionAdmin.token)).status).toBe(200);
    expect((await api('get', `/v1/staff/${staff.id}`, accessToken)).status).toBe(401);
    const again = await signInMobile(t, staff.person.email);
    expect(again.contexts).toEqual([]);
  });

  it('ends a teacher’s session on the next call even when nothing ended it, if the staff record is no longer active', async () => {
    const staff = await addTeacher();
    const { accessToken } = await signInMobile(t, staff.person.email);
    expect((await api('get', `/v1/staff/${staff.id}`, accessToken)).status).toBe(200);
    // Written behind the API's back, so only the per-request check can notice.
    await ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.society_id', ${societyA}, true)`.execute(trx);
      await sql`update staff_members set status = 0 where id = ${staff.id}`.execute(trx);
    });
    const res = await api('get', `/v1/staff/${staff.id}`, accessToken);
    expect(res.status).toBe(401);
  });

  it('does not list a staff record of a deactivated Institution or Society', async () => {
    const staff = await addTeacher({ homeInstitutionId: second });
    expect((await signInMobile(t, staff.person.email)).contexts).toHaveLength(1);
    expect((await api('delete', `/v1/institutions/${second}`, owner.token)).status).toBe(200);
    expect((await signInMobile(t, staff.person.email)).contexts).toEqual([]);
    const other = await addTeacher({ homeInstitutionId: first });
    expect((await signInMobile(t, other.person.email)).contexts).toHaveLength(1);
    expect((await api('delete', `/v1/platform/societies/${societyA}`, admin)).status).toBe(200);
    expect((await signInMobile(t, other.person.email)).contexts).toEqual([]);
  });

  it('ends a session already open when its home Institution or Society is deactivated, on the next call and on refresh', async () => {
    const inInstitution = await addTeacher({ homeInstitutionId: second });
    const inSociety = await addTeacher({ homeInstitutionId: first });
    const one = await signInMobile(t, inInstitution.person.email);
    const two = await signInMobile(t, inSociety.person.email);
    expect((await api('get', `/v1/staff/${inInstitution.id}`, one.accessToken)).status).toBe(200);
    expect((await api('get', `/v1/staff/${inSociety.id}`, two.accessToken)).status).toBe(200);

    expect((await api('delete', `/v1/institutions/${second}`, owner.token)).status).toBe(200);
    expect((await api('get', `/v1/staff/${inInstitution.id}`, one.accessToken)).status).toBe(401);
    expect((await refresh(one.refreshToken)).status).toBe(401);

    expect((await api('delete', `/v1/platform/societies/${societyA}`, admin)).status).toBe(200);
    expect((await api('get', `/v1/staff/${inSociety.id}`, two.accessToken)).status).toBe(401);
    expect((await refresh(two.refreshToken)).status).toBe(401);
  });

  /** A teacher with a record in Society A and one in a Society B, acting in A: their token, both records, B's Owner. */
  const teacherInTwoSocieties = async () => {
    const societyB = await makeSociety();
    const ownerB = await fixtures.owner(societyB);
    const institutionB = await makeInstitution(ownerB.token);
    const inA = await addTeacher();
    const inBResponse = await api('post', '/v1/staff', ownerB.token, {
      homeInstitutionId: institutionB,
      email: inA.person.email,
      firstName: 'Meera',
      classCategoryId: categoryId,
      mobile: { countryCode: '91', number: '9876500001' },
    });
    expect(inBResponse.status).toBe(201);
    const inB = inBResponse.body.data as { id: string };

    const login = await signInMobile(t, inA.person.email);
    expect(login.contexts.map((c) => [c.roleCode, c.societyId]).toSorted()).toEqual(
      [
        [TEACHER, societyA],
        [TEACHER, societyB],
      ].toSorted(),
    );
    const chosen = await api('post', '/v1/auth/context', login.accessToken, {
      roleCode: TEACHER,
      societyId: societyA,
    });
    expect(chosen.status).toBe(200);
    const asTeacherInA = chosen.body.data.accessToken as string;
    expect((await api('get', `/v1/staff/${inA.id}`, asTeacherInA)).status).toBe(200);
    // The own record of the other Society is as if it did not exist.
    expect((await api('get', `/v1/staff/${inB.id}`, asTeacherInA)).status).toBe(404);
    return { inA, inB, ownerB, asTeacherInA };
  };

  it('keeps a teacher’s session in one Society when their record in the other Society ends', async () => {
    const { inA, inB, ownerB, asTeacherInA } = await teacherInTwoSocieties();
    expect((await api('delete', `/v1/staff/${inB.id}`, ownerB.token)).status).toBe(200);
    expect((await api('get', `/v1/staff/${inA.id}`, asTeacherInA)).status).toBe(200);
  });

  it('ends a teacher’s session in a Society when their record there ends, though they still have one in another', async () => {
    const { inA, asTeacherInA } = await teacherInTwoSocieties();
    // Written behind the API's back, so only the per-request check can notice.
    await ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.society_id', ${societyA}, true)`.execute(trx);
      await sql`update staff_members set status = 0 where id = ${inA.id}`.execute(trx);
    });
    expect((await api('get', `/v1/staff/${inA.id}`, asTeacherInA)).status).toBe(401);
  });

  it('gives a person who is Owner and staff both contexts, and keeps the Owner when the staff record ends', async () => {
    const staff = await addTeacher({ email: owner.email });
    expect(staff.person.id).toBe(owner.person);
    const login = await signInMobile(t, owner.email);
    expect(login.contexts.map((c) => c.roleCode).toSorted()).toEqual([OWNER, TEACHER]);
    expect(login.session.activeContext).toBeNull();

    const chosen = await api('post', '/v1/auth/context', login.accessToken, {
      roleCode: TEACHER,
      societyId: societyA,
    });
    expect(chosen.status).toBe(200);
    const asTeacher = chosen.body.data.accessToken as string;
    expect((await api('get', `/v1/staff/${staff.id}`, asTeacher)).status).toBe(200);

    expect((await api('delete', `/v1/staff/${staff.id}`, institutionAdmin.token)).status).toBe(200);
    // The session acting as the teacher ends; the person is still the Owner.
    expect((await api('get', `/v1/staff/${staff.id}`, asTeacher)).status).toBe(401);
    const later = await signInMobile(t, owner.email);
    expect(later.contexts.map((c) => c.roleCode)).toEqual([OWNER]);
    expect(later.session.activeContext).toMatchObject({ roleCode: OWNER });
    expect((await api('get', `/v1/institutions/${first}`, later.accessToken)).status).toBe(200);
  });

  it('answers the staff lookup only for the person asked about, from a tenant transaction of any Society, and puts the settings back', async () => {
    const mine = await addTeacher();
    const colleague = await addTeacher();
    const societyB = await makeSociety();
    const ownerB = await fixtures.owner(societyB);
    const institutionB = await makeInstitution(ownerB.token);
    const theirs = await api('post', '/v1/staff', ownerB.token, {
      homeInstitutionId: institutionB,
      email: `${newId()}@staff.test`,
      firstName: 'Kiran',
      classCategoryId: categoryId,
      mobile: { countryCode: '91', number: '9876500002' },
    });
    expect(theirs.status).toBe(201);
    const other = theirs.body.data.person as { id: string };
    staffUsers.push(other.id);

    const database = t.app.get(DatabaseService);
    const asked = (tenant: Parameters<DatabaseService['transaction']>[0], person: string) =>
      database.transaction(tenant, async (tx) => {
        const found = await sql<{
          society_id: string;
          home_institution_id: string;
        }>`select * from app_staff_roles(${person}::uuid)`.execute(tx);
        const settings = await sql<{ role: string; society: string; person: string }>`
          select current_setting('app.role_code') as role, current_setting('app.society_id') as society,
            current_setting('app.person_id') as person`.execute(tx);
        return {
          roles: found.rows.map((row) => [row.society_id, row.home_institution_id]),
          settings: settings.rows[0],
        };
      });
    const inA = {
      societyId: societyA,
      roleCode: OWNER,
      personId: owner.person,
      institutionIds: [first],
    };
    const inB = {
      societyId: societyB,
      roleCode: OWNER,
      personId: ownerB.person,
      institutionIds: [institutionB],
    };

    // From the teacher's own Society, with a colleague there: the one person's row, and the settings as they were.
    expect(await asked(inA, mine.person.id)).toEqual({
      roles: [[societyA, first]],
      settings: { role: '2', society: societyA, person: owner.person },
    });
    expect((await asked(inA, colleague.person.id)).roles).toEqual([[societyA, first]]);
    // From another Society: still only that person's own row, and the other Society's teacher is not mixed in.
    expect(await asked(inB, mine.person.id)).toEqual({
      roles: [[societyA, first]],
      settings: { role: '2', society: societyB, person: ownerB.person },
    });
    expect((await asked(inA, other.id)).roles).toEqual([[societyB, institutionB]]);
    // A stranger has none, and a person with no Society set in the transaction is answered the same way.
    expect((await asked(inA, newId())).roles).toEqual([]);
    expect(await asked({ roleCode: OWNER }, mine.person.id)).toEqual({
      roles: [[societyA, first]],
      settings: { role: '2', society: '', person: '' },
    });
  });
});
