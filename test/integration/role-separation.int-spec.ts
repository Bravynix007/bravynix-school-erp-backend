import { Kysely, PostgresDialect, sql } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { superAdminToken } from '../support/admin-token.js';
import { apiCaller } from '../support/api.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { removeScratchPeople, scratchEmail } from '../support/scratch-people.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const seededOwner = personaByKey('SO-A1');

/** A Super Admin and a Society Owner are never the same person (PRD 5.2, owner decision 27 Oct 2026). */
describe('Super Admin and Society Owner are kept separate', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const emails: string[] = [];

  const email = () => {
    const made = scratchEmail();
    emails.push(made);
    return made;
  };

  const createSociety = async (fields: Record<string, unknown> = {}) => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Education Trust',
      code: `S${newId().slice(-12)}`,
      ...fields,
    });
    if (res.status === 201) societies.push(res.body.data.id);
    return res;
  };

  const addOwner = (societyId: string, body: object) =>
    api('post', `/v1/platform/societies/${societyId}/owners`, admin, body);
  const addSuperAdmin = (body: object) => api('post', '/v1/platform/super-admins', admin, body);

  const activeGrants = async (userId: string) =>
    (
      await sql<{ role_code: number }>`select role_code from role_assignments
        where user_id = ${userId} and revoked_at is null order by role_code`.execute(ownerDb)
    ).rows.map((row) => row.role_code);

  /** A person with an account and no role yet. */
  const pendingPerson = async () => {
    const address = email();
    const row = await sql<{ id: string }>`
      insert into users (email, account_status) values (${address}, 3) returning id`.execute(
      ownerDb,
    );
    return { id: row.rows[0]!.id, email: address };
  };

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    api = apiCaller(t);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    await removeScratchPeople(ownerDb, emails.splice(0));
    // A failing run must not leave a seeded person with both roles behind for the next run.
    await sql`delete from role_assignments
      where (user_id = ${superAdmin.id} and role_code = 2)
        or (user_id = ${seededOwner.id} and role_code = 1)`.execute(ownerDb);
  });

  it('refuses a Super Admin as the Owner of a Society (PLT-09), and adds nothing', async () => {
    const society = (await createSociety()).body.data.id;
    const res = await addOwner(society, { email: superAdmin.email });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLE_CONFLICT');
    expect(await activeGrants(superAdmin.id)).toEqual([1]);
    const detail = await api('get', `/v1/platform/societies/${society}`, admin);
    expect(detail.body.data.owners).toEqual([]);
  });

  it('refuses a Super Admin among the first Owners of a new Society (PLT-03), and makes no Society', async () => {
    const code = `S${newId().slice(-12)}`;
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'Sunrise Education Trust',
      code,
      owners: [{ email: superAdmin.email }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLE_CONFLICT');
    expect(res.body.errors).toContainEqual(
      expect.objectContaining({ field: 'owners[0].email', code: 'ROLE_CONFLICT' }),
    );
    // Societies force row security on their owner too: read as the platform role, or this finds nothing anyway.
    const left = await ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      return sql`select 1 from societies where code = ${code}`.execute(tx);
    });
    expect(left.rows).toEqual([]);
    expect(await activeGrants(superAdmin.id)).toEqual([1]);
  });

  it('refuses a Society Owner as a Super Admin (PLT-13), and adds nothing', async () => {
    const res = await addSuperAdmin({ email: seededOwner.email });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLE_CONFLICT');
    expect(await activeGrants(seededOwner.id)).toEqual([2]);
  });

  it('allows the role once the other has been taken away', async () => {
    const society = (await createSociety()).body.data.id;
    const person = email();
    const first = await addOwner(society, { email: person });
    expect(first.status).toBe(201);
    expect((await addOwner(society, { email: email() })).status).toBe(201);
    const id = first.body.data.id as string;

    expect((await addSuperAdmin({ email: person })).body.code).toBe('ROLE_CONFLICT');
    expect(
      (await api('delete', `/v1/platform/societies/${society}/owners/${id}`, admin)).status,
    ).toBe(200);
    const now = await addSuperAdmin({ email: person });
    expect(now.status).toBe(201);
    expect(await activeGrants(id)).toEqual([1]);
    expect((await addOwner(society, { email: person })).body.code).toBe('ROLE_CONFLICT');
  });

  it('lets two requests that give the same person both roles succeed only once', async () => {
    for (let round = 0; round < 5; round++) {
      const society = (await createSociety()).body.data.id;
      const person = await pendingPerson();
      const [asOwner, asAdmin] = await Promise.all([
        addOwner(society, { email: person.email }),
        addSuperAdmin({ email: person.email }),
      ]);
      expect([asOwner.status, asAdmin.status].toSorted()).toEqual([201, 409]);
      const refused = asOwner.status === 409 ? asOwner : asAdmin;
      expect(refused.body.code).toBe('ROLE_CONFLICT');
      expect(await activeGrants(person.id)).toHaveLength(1);
      await sql`delete from role_assignments where user_id = ${person.id}`.execute(ownerDb);
    }
  });
});
