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
const secondAdmin = personaByKey('SA2');
const code = () => `Q${newId().slice(-12)}`;

/** QA attacks on the Super Admin and Society Owner separation (owner decision 27 Oct 2026). */
describe('QA: Super Admin and Society Owner separation', () => {
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

  const onboard = async (owners: object[]) => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'QA Separation Trust',
      code: code(),
      owners,
    });
    if (res.status === 201) societies.push(res.body.data.id);
    return res;
  };
  const addOwner = (societyId: string, body: object) =>
    api('post', `/v1/platform/societies/${societyId}/owners`, admin, body);
  const addSuperAdmin = (body: object) => api('post', '/v1/platform/super-admins', admin, body);

  const rolesOf = async (userId: string) =>
    (
      await sql<{ role_code: number }>`select role_code from role_assignments
        where user_id = ${userId} and revoked_at is null order by role_code`.execute(ownerDb)
    ).rows.map((row) => row.role_code);

  const pendingPerson = async () => {
    const address = email();
    const row = await sql<{ id: string }>`
      insert into users (email, account_status) values (${address}, 3) returning id`.execute(
      ownerDb,
    );
    return { id: row.rows[0]!.id, email: address };
  };

  /** Societies force row security on their owner too, so this reads as the platform role. */
  const societiesWithCode = async (value: string) =>
    ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      return (await sql`select id from societies where code = ${value}`.execute(tx)).rows.length;
    });

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
    await removeScratchPeople(ownerDb, emails.splice(0));
    await removeScratchSocieties(ownerDb, societies.splice(0));
  });

  it('Q1 a Super Admin email in another case, or second among the Owners, is still refused, and nothing is made', async () => {
    const newOwner = email();
    const value = code();
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'QA Separation Trust',
      code: value,
      owners: [{ email: newOwner }, { email: secondAdmin.email.toUpperCase() }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLE_CONFLICT');
    expect(await societiesWithCode(value)).toBe(0);
    const left = await sql`select 1 from users where email = ${newOwner}`.execute(ownerDb);
    expect(left.rows).toEqual([]);

    const society = (await onboard([{ email: email() }])).body.data.id as string;
    const cased = await addOwner(society, { email: `SA2@Two-Worlds.TEST` });
    expect(cased.body.code).toBe('ROLE_CONFLICT');
    expect(await rolesOf(secondAdmin.id)).toEqual([1]);
  });

  it('Q2 a brand-new email given both roles at once ends with one role', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 5; round++) {
      const society = (await onboard([{ email: email() }])).body.data.id as string;
      const person = email();
      const [asOwner, asAdmin] = await Promise.all([
        addOwner(society, { email: person }),
        addSuperAdmin({ email: person }),
      ]);
      outcomes.push(
        `${asOwner.status}/${asOwner.body.code ?? '-'} ${asAdmin.status}/${asAdmin.body.code ?? '-'}`,
      );
      const user = await sql<{ id: string }>`select id from users where email = ${person}`.execute(
        ownerDb,
      );
      expect(user.rows).toHaveLength(1);
      expect(await rolesOf(user.rows[0]!.id)).toHaveLength(1);
      await sql`delete from role_assignments where user_id = ${user.rows[0]!.id} and role_code = 1`.execute(
        ownerDb,
      );
    }
    console.log('Q2 owner/admin outcomes:', outcomes.join(' | '));
  });

  it('Q3 two onboardings naming the same two people in opposite order both finish, without a deadlock', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 10; round++) {
      const p1 = await pendingPerson();
      const p2 = await pendingPerson();
      const [one, two] = await Promise.all([
        onboard([{ email: p1.email }, { email: p2.email }]),
        onboard([{ email: p2.email }, { email: p1.email }]),
      ]);
      outcomes.push(`${one.status}/${one.body.code ?? '-'} ${two.status}/${two.body.code ?? '-'}`);
    }
    console.log('Q3 outcomes:', outcomes.join(' | '));
    expect(outcomes.every((outcome) => outcome === '201/CREATED 201/CREATED')).toBe(true);
  });

  it('Q4 a removed Super Admin can become an Owner, and that Owner cannot come back as Super Admin', async () => {
    const person = email();
    const added = await addSuperAdmin({ email: person });
    expect(added.status).toBe(201);
    const id = added.body.data.id as string;
    const society = (await onboard([{ email: email() }])).body.data.id as string;
    expect((await addOwner(society, { email: person })).body.code).toBe('ROLE_CONFLICT');
    expect((await api('delete', `/v1/platform/super-admins/${id}`, admin)).status).toBe(200);
    expect((await addOwner(society, { email: person })).status).toBe(201);
    expect(await rolesOf(id)).toEqual([2]);
    expect((await addSuperAdmin({ email: person })).body.code).toBe('ROLE_CONFLICT');
    // Clean up the seat so the next test sees two Super Admins.
    await sql`delete from role_assignments where user_id = ${id}`.execute(ownerDb);
  });

  it('Q5 the Owner of a deactivated Society has no seat left, so can become a Super Admin', async () => {
    const person = email();
    const society = (await onboard([{ email: person }])).body.data.id as string;
    expect((await api('delete', `/v1/platform/societies/${society}`, admin)).status).toBe(200);
    const user = await sql<{ id: string }>`select id from users where email = ${person}`.execute(
      ownerDb,
    );
    expect(await rolesOf(user.rows[0]!.id)).toEqual([]);
    expect((await addSuperAdmin({ email: person })).status).toBe(201);
    await sql`delete from role_assignments where user_id = ${user.rows[0]!.id} and role_code = 1`.execute(
      ownerDb,
    );
  });

  it('Q6 one person sent as Owner of two Societies and as Super Admin, all at once: Owner wins or Admin wins, never both', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 5; round++) {
      const a = (await onboard([{ email: email() }])).body.data.id as string;
      const b = (await onboard([{ email: email() }])).body.data.id as string;
      const person = await pendingPerson();
      const results = await Promise.all([
        addOwner(a, { email: person.email }),
        addSuperAdmin({ email: person.email }),
        addOwner(b, { email: person.email }),
      ]);
      outcomes.push(results.map((r) => `${r.status}/${r.body.code ?? '-'}`).join(' '));
      const roles = await rolesOf(person.id);
      expect(roles.includes(1) && roles.includes(2)).toBe(false);
      expect(results.some((r) => r.status >= 500)).toBe(false);
      await sql`delete from role_assignments where user_id = ${person.id}`.execute(ownerDb);
    }
    console.log('Q6 outcomes (owner A, admin, owner B):', outcomes.join(' | '));
  });
});
