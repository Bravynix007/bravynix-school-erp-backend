import { Kysely, PostgresDialect, sql } from 'kysely';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, succeeded, type SchoolStaff } from '../support/school-kit.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const ADMIN = 3;
const TEACHER = 4;

/**
 * A teacher whose home Institution has been closed (API design 10.4i): adding the person again at another Institution
 * ends the old record as STF-05 ends it, and starts the new one. Only the Society Owner does it.
 */
describe('adding a person whose home Institution is closed', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let owner: SignedInPerson;
  let societyId: string;
  let first: string;
  let second: string;
  let categoryId: string;
  let sectionId: string;
  let subjectId: string;
  let yearId: string;
  let dev: SchoolStaff;

  const add = (token: string, staff: SchoolStaff, homeInstitutionId = second) =>
    api('post', '/v1/staff', token, {
      homeInstitutionId,
      email: staff.person.email,
      firstName: 'Dev',
      classCategoryId: categoryId,
      mobile: { countryCode: '91', number: '9876500001' },
    });
  const read = <T>(
    work: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<T>,
  ) =>
    database.transaction(
      { personId: owner.person, roleCode: 2, societyId, institutionIds: [first, second] },
      work,
    );
  // Three code requests per email in 15 minutes: a test that signs in more often waits for the next window.
  const roles = async (nextWindow = false) => {
    if (nextWindow) t.clock.advance(15 * 60_000);
    return (await signInMobile(t, dev.person.email)).contexts
      .map((context) => context.roleCode)
      .toSorted();
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
    const admin = await superAdminToken(t, ownerDb, superAdmin.id);
    categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    const classId = (await kit.masters(admin, 'predefined-classes')).find(
      (c) => c.code === 'C09',
    )!.id;
    const predefinedSection = (await kit.masters(admin, 'predefined-sections'))[0]!.id;
    societyId = await kit.society(admin);
    owner = await fixtures.owner(societyId);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    yearId = await kit.year(owner.token, first);
    sectionId = await kit.section(
      owner.token,
      await kit.klass(owner.token, first, classId),
      predefinedSection,
    );
    subjectId = await kit.subject(owner.token, 'Mathematics');
    dev = await kit.staff(owner.token, first, categoryId, { firstName: 'Dev' });
    succeeded(
      await api('put', `/v1/staff/${dev.id}/subjects`, owner.token, { subjectIds: [subjectId] }),
      200,
      'subjects',
    );
    succeeded(
      await api('put', `/v1/staff/${dev.id}/institutions`, owner.token, {
        institutionIds: [second],
      }),
      200,
      'extra Institution',
    );
    succeeded(
      await api('post', '/v1/teaching-assignments', owner.token, {
        staffMemberId: dev.id,
        academicYearId: yearId,
        sectionId,
        subjectId,
      }),
      201,
      'assignment',
    );
    succeeded(
      await api('post', `/v1/institutions/${second}/admins`, owner.token, {
        staffMemberId: dev.id,
      }),
      201,
      'Admin grant at the extra Institution',
    );
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  it('ends the old record with its assignments, Admin access and sessions, and starts the new one', async () => {
    const teacherToken = await kit.actingAs(dev.person.email, TEACHER, societyId);
    const adminToken = await kit.actingAs(dev.person.email, ADMIN, societyId);
    succeeded(await api('delete', `/v1/institutions/${first}`, owner.token), 200, 'close');
    // Closing the school changes nothing more: the record stays active, its Admin grant at the extra Institution too.
    expect(await roles()).toEqual([ADMIN]);

    const replaced = await add(owner.token, dev);
    expect(replaced.status).toBe(201);
    expect(replaced.body.data.id).not.toBe(dev.id);
    expect(replaced.body.data.homeInstitutionId).toBe(second);
    expect((replaced.body.data.person as { id: string }).id).toBe(dev.person.id);

    expect((await api('get', `/v1/classes?institutionId=${second}`, teacherToken)).status).toBe(
      401,
    );
    expect((await api('get', `/v1/institutions/${second}/admins`, adminToken)).status).toBe(401);
    expect((await api('get', `/v1/institutions/${second}/admins`, owner.token)).body.data).toEqual(
      [],
    );

    const { old, assignments, entries } = await read(async (tx) => ({
      old: (
        await sql<{
          status: number;
        }>`select status from staff_members where id = ${dev.id}`.execute(tx)
      ).rows[0],
      assignments: (
        await sql<{ ended: boolean }>`
          select ended_at is not null as ended from teaching_assignments where staff_member_id = ${dev.id}
        `.execute(tx)
      ).rows,
      entries: (
        await sql<{ action: string; entity_id: string; institution_id: string }>`
          select action, entity_id, institution_id from audit_logs
            where entity_id in (${dev.id}, ${replaced.body.data.id}) and action in ('staff.created', 'staff.deactivated')
            order by created_at, action
        `.execute(tx)
      ).rows,
    }));
    // The person is a teacher at the second Institution only: the Admin access ended with the old record.
    expect(await roles(true)).toEqual([TEACHER]);
    expect(old).toEqual({ status: 0 });
    expect(assignments).toEqual([{ ended: true }]);
    expect(
      entries.map((entry) => [entry.action, entry.entity_id, entry.institution_id]).toSorted(),
    ).toEqual(
      [
        ['staff.created', dev.id, first],
        ['staff.deactivated', dev.id, first],
        ['staff.created', replaced.body.data.id, second],
      ].toSorted(),
    );
  });

  it('answers DUPLICATE while the home Institution is open, and changes nothing', async () => {
    const refused = await add(owner.token, dev);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DUPLICATE');
    expect(await roles()).toEqual([ADMIN, TEACHER]);
  });

  it('is for the Society Owner alone: an Institution Admin still gets DUPLICATE', async () => {
    succeeded(await api('delete', `/v1/institutions/${first}`, owner.token), 200, 'close');
    const institutionAdmin = await fixtures.institutionAdmin(societyId, [second]);
    const refused = await add(institutionAdmin.token, dev);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DUPLICATE');
    expect((await add(owner.token, dev)).status).toBe(201);
  });
});
