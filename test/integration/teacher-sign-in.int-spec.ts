import { Kysely, PostgresDialect, sql } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
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

const staffRolesOf = async (db: Kysely<unknown>, person: string) =>
  (
    await sql<{ society_id: string; home_institution_id: string; staff_blocked: boolean }>`
      select * from app_staff_roles(${person})
    `.execute(db)
  ).rows;

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

  it('answers the staff lookup only for the person asked about, from any caller’s transaction', async () => {
    const staff = await addTeacher();
    const other = await addTeacher();
    expect(await staffRolesOf(ownerDb, staff.person.id)).toEqual([
      expect.objectContaining({ society_id: societyA, home_institution_id: first }),
    ]);
    expect(await staffRolesOf(ownerDb, newId())).toEqual([]);
    expect((await staffRolesOf(ownerDb, other.person.id)).length).toBe(1);
  });
});
