import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller, type Body } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

type Method = 'get' | 'post' | 'patch' | 'delete';

/** The IDs of the rows a list answered, in order. */
const ids = (res: { body: Body }) =>
  (res.body.data as unknown as { id: string }[]).map((s) => s.id);

describe('PLT-02 to PLT-08 Societies', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let admin: string;
  const made: string[] = [];
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;

  const call = (method: Method, path: string, body: object = {}, token = admin) =>
    api(method, path, token, body);

  /** Creates a Society through the API; removed after the test. */
  const create = async (fields: Record<string, unknown> = {}) => {
    const res = await call('post', '/v1/platform/societies', {
      name: 'Sunrise Education Trust',
      code: `S${newId().slice(-12)}`,
      ...fields,
    });
    expect(res.status).toBe(201);
    made.push(res.body.data.id);
    return res.body.data;
  };

  const ownerOf = (societyId: string) => fixtures.owner(societyId);

  const list = (query: string) => call('get', `/v1/platform/societies?${query}`);

  const audit = (societyId: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      reason: string | null;
      old_values: string | null;
      new_values: string | null;
      entity_id: string;
    }>(
      ownerDb,
      sql`society_id = ${societyId} and action like 'society.%' or action like 'access.%' and society_id = ${societyId}`,
    );

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
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await removeScratchSocieties(ownerDb, made.splice(0));
    await fixtures.cleanup();
  });

  describe('who may call', () => {
    it('refuses a Society Owner, a signed-out caller and a bad token', async () => {
      const society = await create();
      const owner = await ownerOf(society.id);
      const asOwner = await call('get', '/v1/platform/societies', {}, owner.token);
      expect(asOwner.status).toBe(403);
      expect(asOwner.body.code).toBe('FORBIDDEN');
      expect((await call('post', '/v1/platform/societies', {}, owner.token)).status).toBe(403);
      expect((await request(t.app.getHttpServer()).get('/v1/platform/societies')).status).toBe(401);
    });
  });

  describe('PLT-03 create', () => {
    it('answers 201 with the whole Society, every field present, and stamps the author', async () => {
      const res = await call('post', '/v1/platform/societies', {
        name: 'Sunrise Education Trust',
        code: 'SUNRISE-1',
        description: 'Schools since 1998',
        email: 'Office@Sunrise.Example.org',
        phone: { countryCode: '91', number: '9876543210' },
        website: 'https://sunrise.example.org',
        foundedDate: '1998-06-01',
        address: { line1: '1 Temple Road', line2: null, pincode: '560001' },
      });
      made.push(res.body.data.id);
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        id: expect.any(String),
        code: 'SUNRISE-1',
        name: 'Sunrise Education Trust',
        description: 'Schools since 1998',
        email: 'office@sunrise.example.org',
        phone: { countryCode: '91', number: '9876543210' },
        website: 'https://sunrise.example.org',
        foundedDate: '1998-06-01',
        address: { line1: '1 Temple Road', line2: null, pincode: '560001' },
        status: 1,
        blockedSections: [],
        institutionCount: 0,
        institutions: [],
        owners: [],
        version: 1,
        createdBy: { id: superAdmin.id, displayName: expect.any(String), roleName: 'Super Admin' },
        createdAt: expect.stringMatching(/Z$/),
        updatedBy: { id: superAdmin.id, displayName: expect.any(String), roleName: 'Super Admin' },
        updatedAt: expect.stringMatching(/Z$/),
      });
    });

    it('shows empty optional fields as null, never missing', async () => {
      const society = await create();
      expect(society).toMatchObject({
        description: null,
        email: null,
        phone: null,
        website: null,
        foundedDate: null,
        address: { line1: null, line2: null, pincode: null },
      });
    });

    it('audits the creation with the Society ID', async () => {
      const society = await create({ description: 'First' });
      const [entry, ...rest] = await audit(society.id);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        action: 'society.create',
        actor_user_id: superAdmin.id,
        entity_id: society.id,
      });
      expect(entry!.new_values).toMatchObject({
        name: society.name,
        description: 'First',
      });
    });

    it('answers 409 DUPLICATE on the code field, whatever the letter case', async () => {
      const society = await create({ code: 'Dup-Code' });
      for (const code of ['Dup-Code', 'DUP-CODE', 'dup-code']) {
        const res = await call('post', '/v1/platform/societies', { name: 'Other', code });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'DUPLICATE',
          errors: [{ field: 'code', code: 'DUPLICATE' }],
        });
      }
      expect(society.code).toBe('Dup-Code');
    });

    it.each([
      ['no name', { code: 'X' }, 'name', 'REQUIRED'],
      ['no code', { name: 'X' }, 'code', 'REQUIRED'],
      ['a blank name', { name: '   ', code: 'X' }, 'name', 'REQUIRED'],
      ['a name over 255', { name: 'n'.repeat(256), code: 'X' }, 'name', 'TOO_LONG'],
      ['a number as the code', { name: 'X', code: 5 }, 'code', 'INVALID_TYPE'],
      ['a status', { name: 'X', code: 'X', status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
      ['an author', { name: 'X', code: 'X', createdBy: 'me' }, 'createdBy', 'FIELD_NOT_ALLOWED'],
      [
        'an empty description',
        { name: 'X', code: 'X', description: '' },
        'description',
        'TOO_SHORT',
      ],
      [
        'an empty address line',
        { name: 'X', code: 'X', address: { line1: '' } },
        'address.line1',
        'TOO_SHORT',
      ],
      ['a bad email', { name: 'X', code: 'X', email: 'nope' }, 'email', 'INVALID_FORMAT'],
      [
        'a website without a scheme',
        { name: 'X', code: 'X', website: 'sunrise.org' },
        'website',
        'INVALID_FORMAT',
      ],
      [
        'a 3-digit-short number',
        { name: 'X', code: 'X', phone: { countryCode: '91', number: '123' } },
        'phone.number',
        'INVALID_FORMAT',
      ],
      [
        'an impossible date',
        { name: 'X', code: 'X', foundedDate: '2026-02-30' },
        'foundedDate',
        'INVALID_FORMAT',
      ],
      [
        'a pincode over 10',
        { name: 'X', code: 'X', address: { pincode: '1'.repeat(11) } },
        'address.pincode',
        'TOO_LONG',
      ],
      [
        'an address field that is not one',
        { name: 'X', code: 'X', address: { city: 'Pune' } },
        'address.city',
        'FIELD_NOT_ALLOWED',
      ],
    ])('answers 400 for %s', async (_what, body, field, code) => {
      const res = await call('post', '/v1/platform/societies', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors).toContainEqual(expect.objectContaining({ field, code }));
    });
  });

  describe('PLT-02 list', () => {
    it('pages, filters and sorts', async () => {
      const tag = newId().slice(-8);
      const a = await create({ name: `Alpha ${tag}`, code: `a-${tag}` });
      const b = await create({ name: `beta ${tag}`, code: `B-${tag}` });
      const c = await create({ name: `Gamma ${tag}`, code: `c-${tag}` });
      await call('post', '/v1/platform/access-blocks', {
        section: 'owners',
        societyId: c.id,
        reason: 'Dues',
      });
      await call('delete', `/v1/platform/societies/${b.id}`);

      const found = await list(`q=${tag}`);
      expect(found.status).toBe(200);
      expect(ids(found)).toEqual([a.id, b.id, c.id]); // by name, ignoring case
      expect(found.body.meta).toEqual({ page: 1, limit: 20, totalItems: 3, totalPages: 1 });
      expect((found.body.data as unknown as Record<string, unknown>[])[0]).toEqual({
        id: a.id,
        code: `a-${tag}`,
        name: `Alpha ${tag}`,
        status: 1,
        blocked: false,
        institutionCount: 0,
        createdBy: expect.objectContaining({ id: superAdmin.id }),
        createdAt: expect.any(String),
        updatedBy: expect.objectContaining({ id: superAdmin.id }),
        updatedAt: expect.any(String),
      });

      expect(ids(await list(`q=${tag.toUpperCase()}`))).toHaveLength(3);
      expect(ids(await list(`q=${tag}&status=0`))).toEqual([b.id]);
      expect(ids(await list(`q=${tag}&status=0&status=1`))).toHaveLength(3);
      expect(ids(await list(`q=${tag}&blocked=true`))).toEqual([c.id]);
      expect(ids(await list(`q=${tag}&blocked=false&status=1`))).toEqual([a.id]);
      expect(ids(await list(`q=${tag}&sort=-name`))).toEqual([c.id, b.id, a.id]);
      expect(ids(await list(`q=${tag}&sort=code`))).toEqual([a.id, b.id, c.id]);
      expect(ids(await list(`q=${tag}&sort=-createdAt`))).toEqual([c.id, b.id, a.id]);

      const second = await list(`q=${tag}&limit=2&page=2`);
      expect(ids(second)).toEqual([c.id]);
      expect(second.body.meta).toEqual({ page: 2, limit: 2, totalItems: 3, totalPages: 2 });
    });

    it('takes % and _ in a search as plain characters', async () => {
      await create({ name: 'Plain Trust' });
      const res = await call('get', '/v1/platform/societies?q=%25%25');
      expect(res.body.meta).toMatchObject({ totalItems: 0 });
    });

    it('answers 400 for an unknown sort, a bad status, a page past the limit and a short search', async () => {
      expect((await list('sort=email')).body.code).toBe('INVALID_SORT');
      expect((await list('status=2')).body.code).toBe('VALIDATION_FAILED');
      expect((await list('status=x')).body.code).toBe('VALIDATION_FAILED');
      expect((await list('blocked=maybe')).body.code).toBe('VALIDATION_FAILED');
      expect((await list('page=10001')).body.errors).toContainEqual(
        expect.objectContaining({ field: 'page', code: 'OUT_OF_RANGE' }),
      );
      expect((await list('q=a')).body.errors).toContainEqual(
        expect.objectContaining({ field: 'q', code: 'TOO_SHORT' }),
      );
    });
  });

  describe('PLT-04 detail', () => {
    it('shows the Institutions and the Owners', async () => {
      const society = await create();
      const owner = await ownerOf(society.id);
      const first = newId();
      await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`insert into institutions (id, society_id, name, code, address_line_1, status)
          values (${first}, ${society.id}, 'Zed School', 'Z', '1 Road', 1),
                 (${newId()}, ${society.id}, 'Alpha School', 'A', '2 Road', 0)`.execute(tx);
      });
      const res = await call('get', `/v1/platform/societies/${society.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: society.id, institutionCount: 1 });
      expect(res.body.data.institutions).toEqual([
        { id: expect.any(String), code: 'A', name: 'Alpha School', status: 0, blockedSections: [] },
        { id: first, code: 'Z', name: 'Zed School', status: 1, blockedSections: [] },
      ]);
      expect(res.body.data.owners).toEqual([
        { id: owner.person, displayName: owner.email, email: owner.email, accountStatus: 1 },
      ]);
    });

    it('answers 404 for an unknown or malformed ID', async () => {
      for (const id of [missing, 'not-a-uuid', '123']) {
        const res = await call('get', `/v1/platform/societies/${id}`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('PLT-05 update', () => {
    it('changes the named fields, moves the version and audits before and after', async () => {
      const society = await create({ description: 'Old', email: 'a@b.org' });
      const res = await call('patch', `/v1/platform/societies/${society.id}`, {
        version: 1,
        name: 'Sunrise Trust',
        description: null,
        phone: { countryCode: '91', number: '9876543210' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        name: 'Sunrise Trust',
        description: null,
        email: 'a@b.org',
        phone: { countryCode: '91', number: '9876543210' },
        version: 2,
        code: society.code,
      });
      const entries = await audit(society.id);
      const update = entries.find((entry) => entry.action === 'society.update')!;
      expect(update.old_values!).toEqual({
        name: 'Sunrise Education Trust',
        description: 'Old',
        country_code: null,
        phone_number: null,
      });
      expect(update.new_values!).toEqual({
        name: 'Sunrise Trust',
        description: null,
        country_code: '91',
        phone_number: '9876543210',
      });
    });

    it('replaces the address and phone as a whole, and clears them with null', async () => {
      const society = await create({
        phone: { countryCode: '91', number: '9876543210' },
        address: { line1: 'A', line2: 'B', pincode: '1' },
      });
      const replaced = await call('patch', `/v1/platform/societies/${society.id}`, {
        version: 1,
        address: { line1: 'C' },
      });
      expect(replaced.body.data.address).toEqual({ line1: 'C', line2: null, pincode: null });
      const cleared = await call('patch', `/v1/platform/societies/${society.id}`, {
        version: 2,
        phone: null,
        address: null,
      });
      expect(cleared.body.data).toMatchObject({
        phone: null,
        address: { line1: null, line2: null, pincode: null },
        version: 3,
      });
    });

    it('writes nothing when nothing changes: same version, no audit entry', async () => {
      const society = await create();
      const res = await call('patch', `/v1/platform/societies/${society.id}`, {
        version: 1,
        name: society.name,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(1);
      expect(await audit(society.id)).toHaveLength(1);
    });

    it('answers 409 VERSION_CONFLICT with the current version for a stale screen', async () => {
      const society = await create();
      await call('patch', `/v1/platform/societies/${society.id}`, { version: 1, name: 'New' });
      const res = await call('patch', `/v1/platform/societies/${society.id}`, {
        version: 1,
        name: 'Late',
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'VERSION_CONFLICT', data: { currentVersion: 2 } });
    });

    it('refuses the code, status, blocks and stamps as fields, and needs the version', async () => {
      const society = await create();
      for (const field of ['code', 'status', 'blockedSections', 'accessPause', 'updatedBy', 'id']) {
        const res = await call('patch', `/v1/platform/societies/${society.id}`, {
          version: 1,
          [field]: 'x',
        });
        expect(res.status).toBe(400);
        expect(res.body.errors).toContainEqual(
          expect.objectContaining({ field, code: 'FIELD_NOT_ALLOWED' }),
        );
      }
      const none = await call('patch', `/v1/platform/societies/${society.id}`, { name: 'X' });
      expect(none.body.errors).toContainEqual(
        expect.objectContaining({ field: 'version', code: 'INVALID_TYPE' }),
      );
      const nulled = await call('patch', `/v1/platform/societies/${society.id}`, {
        version: 1,
        name: null,
      });
      expect(nulled.status).toBe(400);
    });

    it('answers 404 for an unknown Society and 409 INVALID_STATE for a deactivated one', async () => {
      expect(
        (await call('patch', `/v1/platform/societies/${missing}`, { version: 1 })).status,
      ).toBe(404);
      const society = await create();
      await call('delete', `/v1/platform/societies/${society.id}`);
      const res = await call('patch', `/v1/platform/societies/${society.id}`, {
        version: 2,
        name: 'Again',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE');
    });
  });

  describe('PLT-07 and PLT-08 are gone', () => {
    it('has no pause or resume route: the Owners are blocked through PLT-42 instead', async () => {
      const society = await create();
      for (const action of ['pause', 'resume']) {
        const res = await call('post', `/v1/platform/societies/${society.id}/${action}`, {
          version: 1,
          reason: 'x',
        });
        expect(res.status).toBe(404);
      }
    });
  });

  describe('PLT-06 deactivate', () => {
    it('answers { id, status: 0 } and ends the Society’s sessions and grants, and nobody else’s', async () => {
      const society = await create();
      const sibling = await create();
      const owner = await ownerOf(society.id);
      const other = await ownerOf(sibling.id);

      const res = await call('delete', `/v1/platform/societies/${society.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: society.id, status: 0 });

      const ended = await call('get', '/v1/me', {}, owner.token);
      expect(ended.status).toBe(401);
      expect(ended.body).toMatchObject({
        code: 'SESSION_ENDED',
        data: { reason: 'admin_revoked' },
      });
      expect((await call('get', '/v1/me', {}, other.token)).status).toBe(200);

      const grants = await sql<{ revoked_by: string; revoke_reason: string }>`
        select revoked_by, revoke_reason from role_assignments where society_id = ${society.id}`.execute(
        ownerDb,
      );
      expect(grants.rows).toEqual([
        { revoked_by: superAdmin.id, revoke_reason: 'society_deactivated' },
      ]);

      const again = await signInMobile(t, owner.email);
      expect(again.contexts).toEqual([]);

      const detail = await call('get', `/v1/platform/societies/${society.id}`);
      expect(detail.body.data).toMatchObject({ status: 0, owners: [] });
      const entry = (await audit(society.id)).find((row) => row.action === 'society.deactivate')!;
      expect(entry.new_values!).toEqual({
        status: 0,
        grantsRevoked: 1,
        sessionsEnded: 1,
      });
    });

    it('answers 409 INVALID_STATE for a Society that is already deactivated, 404 for an unknown one', async () => {
      const society = await create();
      expect((await call('delete', `/v1/platform/societies/${society.id}`)).status).toBe(200);
      const again = await call('delete', `/v1/platform/societies/${society.id}`);
      expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
      expect((await call('delete', `/v1/platform/societies/${missing}`)).status).toBe(404);
      expect((await call('delete', '/v1/platform/societies/nope')).status).toBe(404);
    });
  });
});
