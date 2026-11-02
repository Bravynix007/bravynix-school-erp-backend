import { Kysely, PostgresDialect, sql } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';
const SUBJECTS = '/v1/subjects';

type Method = 'get' | 'post' | 'patch' | 'delete';

interface Subject {
  id: string;
  name: string;
  code: string | null;
  status: number;
  version: number;
}

describe('SUB-01 to SUB-04 subjects (PRD 7.4, API design 10.4i)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];

  /** Society A with two Institutions, an Owner and an Admin of the first; Society B with its Owner. */
  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let otherOwner: SignedInPerson;
  let societyA: string;
  let societyB: string;

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

  const call = (method: Method, path: string, body: object = {}, token = owner.token) =>
    api(method, path, token, body);

  const add = (fields: object, token = owner.token) => call('post', SUBJECTS, fields, token);

  const added = async (fields: object, token = owner.token) => {
    const res = await add(fields, token);
    expect(res.status).toBe(201);
    return res.body.data as unknown as Subject;
  };

  const list = async (token = owner.token) => {
    const res = await call('get', SUBJECTS, {}, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Subject[];
  };

  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      society_id: string;
      institution_id: string | null;
      entity_type: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    fixtures = new PlatformFixtures(t, ownerDb);
    api = apiCaller(t);
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
    const first = await makeInstitution(owner.token);
    await makeInstitution(owner.token);
    institutionAdmin = await fixtures.institutionAdmin(societyA, [first]);
    societyB = await makeSociety();
    otherOwner = await fixtures.owner(societyB);
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    await fixtures.cleanup();
  });

  describe('SUB-02 add a subject', () => {
    it('adds it to the Society, with the code or without, and audits it for the Society alone', async () => {
      const maths = await added({ name: 'Mathematics', code: 'MATH' });
      expect(maths).toMatchObject({ name: 'Mathematics', code: 'MATH', status: 1, version: 1 });
      const art = await added({ name: 'Art' });
      expect(art.code).toBeNull();

      const [row, ...rest] = await audit(maths.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        action: 'subject.created',
        entity_type: 'subject',
        actor_user_id: owner.person,
        society_id: societyA,
        institution_id: null,
        old_values: null,
      });
      expect(row!.new_values).toMatchObject({ name: 'Mathematics', code: 'MATH', status: 1 });
    });

    it('is open to an Institution Admin, who changes the Society’s list for every Institution, and the audit names them', async () => {
      const subject = await added({ name: 'Hindi' }, institutionAdmin.token);
      expect((await list()).map((s) => s.id)).toEqual([subject.id]);
      expect((await audit(subject.id))[0]).toMatchObject({
        actor_user_id: institutionAdmin.person,
        society_id: societyA,
      });
    });

    it('is not for Super Admin', async () => {
      expect((await add({ name: 'Hindi' }, admin)).status).toBe(403);
    });

    it('refuses a name or a code an active subject has, whatever the letter case', async () => {
      await added({ name: 'Mathematics', code: 'MATH' });
      const name = await add({ name: 'mathematics' });
      expect(name.status).toBe(409);
      expect(name.body.errors?.[0]).toMatchObject({ field: 'name', code: 'DUPLICATE' });
      const code = await add({ name: 'Maths', code: 'math' });
      expect(code.status).toBe(409);
      expect(code.body.errors?.[0]).toMatchObject({ field: 'code', code: 'DUPLICATE' });
      expect(await list()).toHaveLength(1);
    });

    it('lets two subjects have no code, and another Society use the same name and code', async () => {
      await added({ name: 'Art' });
      await added({ name: 'Music' });
      await added({ name: 'Art' }, otherOwner.token);
      expect(await list()).toHaveLength(2);
    });

    it('refuses bad fields and fields the caller may not set, writing nothing', async () => {
      const bad = await add({ name: '', code: 'x'.repeat(51), societyId: societyB, status: 0 });
      expect(bad.status).toBe(400);
      const fields = Object.fromEntries((bad.body.errors ?? []).map((e) => [e.field, e.code]));
      expect(fields).toMatchObject({
        name: 'TOO_SHORT',
        code: 'TOO_LONG',
        societyId: 'FIELD_NOT_ALLOWED',
        status: 'FIELD_NOT_ALLOWED',
      });
      expect(await list()).toEqual([]);
    });

    it('trims the name, and gives the name to only one of two requests made together', async () => {
      const trimmed = await added({ name: '  Science  ' });
      expect(trimmed.name).toBe('Science');
      const [a, b] = await Promise.all([add({ name: 'Civics' }), add({ name: 'Civics' })]);
      expect([a.status, b.status].toSorted()).toEqual([201, 409]);
    });
  });

  describe('SUB-01 list the subjects', () => {
    it('lists the active ones by name for the Owner and the Admin, and no other Society’s', async () => {
      await added({ name: 'Science' });
      await added({ name: 'English' });
      await added({ name: 'Art' }, otherOwner.token);
      for (const token of [owner.token, institutionAdmin.token]) {
        expect((await list(token)).map((s) => s.name)).toEqual(['English', 'Science']);
      }
      expect((await list(otherOwner.token)).map((s) => s.name)).toEqual(['Art']);
    });

    it('shows the author stamps and leaves out a deactivated subject', async () => {
      const gone = await added({ name: 'Old' });
      await added({ name: 'New' });
      await call('delete', `${SUBJECTS}/${gone.id}`);
      const [only, ...rest] = await list();
      expect(rest).toEqual([]);
      expect(only).toMatchObject({
        name: 'New',
        createdBy: { id: owner.person, roleName: 'Society Owner' },
      });
    });

    it('is not for Super Admin', async () => {
      expect((await call('get', SUBJECTS, {}, admin)).status).toBe(403);
    });
  });

  describe('SUB-03 edit a subject', () => {
    it('changes the name and code with the version, clears the code with null, and audits before and after', async () => {
      const subject = await added({ name: 'Maths', code: 'M' });
      const res = await call('patch', `${SUBJECTS}/${subject.id}`, {
        version: 1,
        name: 'Mathematics',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ name: 'Mathematics', code: 'M', version: 2 });
      const cleared = await call(
        'patch',
        `${SUBJECTS}/${subject.id}`,
        { version: 2, code: null },
        institutionAdmin.token,
      );
      expect(cleared.body.data).toMatchObject({ code: null, version: 3 });

      const rows = await audit(subject.id);
      expect(rows.map((row) => row.action)).toEqual([
        'subject.created',
        'subject.updated',
        'subject.updated',
      ]);
      expect(rows[1]).toMatchObject({
        old_values: { name: 'Maths' },
        new_values: { name: 'Mathematics' },
      });
      expect(rows[2]).toMatchObject({
        actor_user_id: institutionAdmin.person,
        institution_id: null,
      });
    });

    it('answers a stale version with 409, and a request that changes nothing writes nothing', async () => {
      const subject = await added({ name: 'Maths' });
      await call('patch', `${SUBJECTS}/${subject.id}`, { version: 1, name: 'Changed' });
      const stale = await call('patch', `${SUBJECTS}/${subject.id}`, { version: 1, name: 'Again' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      const same = await call('patch', `${SUBJECTS}/${subject.id}`, {
        version: 2,
        name: 'Changed',
      });
      expect(same.status).toBe(200);
      expect(same.body.data.version).toBe(2);
      expect(await audit(subject.id)).toHaveLength(2);
    });

    it('keeps the rules: a free name and code, no null name, and no status field', async () => {
      await added({ name: 'English', code: 'ENG' });
      const subject = await added({ name: 'Hindi', code: 'HIN' });
      const path = `${SUBJECTS}/${subject.id}`;
      const name = await call('patch', path, { version: 1, name: 'ENGLISH' });
      expect(name.body.errors?.[0]).toMatchObject({ field: 'name', code: 'DUPLICATE' });
      const code = await call('patch', path, { version: 1, code: 'eng' });
      expect(code.body.errors?.[0]).toMatchObject({ field: 'code', code: 'DUPLICATE' });
      expect((await call('patch', path, { version: 1, name: null })).status).toBe(400);
      const status = await call('patch', path, { version: 1, status: 0 });
      expect(status.body.errors?.[0]).toMatchObject({ field: 'status', code: 'FIELD_NOT_ALLOWED' });
      expect((await list()).find((s) => s.id === subject.id)!.version).toBe(1);
    });

    it('is 404 for another Society’s subject, a deactivated one, or an unknown or malformed ID', async () => {
      const foreign = await added({ name: 'Art' }, otherOwner.token);
      const gone = await added({ name: 'Old' });
      await call('delete', `${SUBJECTS}/${gone.id}`);
      for (const id of [foreign.id, gone.id, missing, 'nope']) {
        expect((await call('patch', `${SUBJECTS}/${id}`, { version: 1, name: 'x' })).status).toBe(
          404,
        );
      }
      expect((await list(otherOwner.token))[0]!.name).toBe('Art');
    });
  });

  describe('SUB-04 deactivate a subject', () => {
    it('hides it, frees its name and code, keeps the row, and audits it', async () => {
      const subject = await added({ name: 'Maths', code: 'M' });
      const res = await call('delete', `${SUBJECTS}/${subject.id}`, {}, institutionAdmin.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: subject.id, status: 0 });
      expect(await list()).toEqual([]);

      const again = await add({ name: 'Maths', code: 'M' });
      expect(again.status).toBe(201);

      const stored = await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.society_id', ${societyA}, true)`.execute(tx);
        return sql<{
          status: number;
        }>`select status from subjects where id = ${subject.id}`.execute(tx);
      });
      expect(stored.rows).toEqual([{ status: 0 }]);
      expect((await audit(subject.id)).at(-1)).toMatchObject({
        action: 'subject.deactivated',
        actor_user_id: institutionAdmin.person,
        old_values: { status: 1 },
        new_values: { status: 0 },
      });
    });

    it('is 404 when already deactivated, for another Society’s subject, or an unknown one', async () => {
      const foreign = await added({ name: 'Art' }, otherOwner.token);
      const subject = await added({ name: 'Maths' });
      await call('delete', `${SUBJECTS}/${subject.id}`);
      for (const id of [subject.id, foreign.id, missing]) {
        expect((await call('delete', `${SUBJECTS}/${id}`)).status).toBe(404);
      }
      expect((await list(otherOwner.token)).map((s) => s.name)).toEqual(['Art']);
    });

    it('is not for Super Admin', async () => {
      const subject = await added({ name: 'Maths' });
      expect((await call('delete', `${SUBJECTS}/${subject.id}`, {}, admin)).status).toBe(403);
    });
  });
});
