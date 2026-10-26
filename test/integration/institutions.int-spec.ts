import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';

type Method = 'get' | 'post' | 'patch' | 'delete';

interface Body {
  success: boolean;
  code: string;
  data: { id: string; version: number } & Record<string, unknown>;
  meta: Record<string, unknown> | null;
  errors?: { field: string; code: string }[];
}

/** The IDs of the rows a list answered, in order. */
const ids = (res: { body: Body }) =>
  (res.body.data as unknown as { id: string }[]).map((r) => r.id);

describe('PLT-19 to PLT-21 and INS-01 to INS-05 Institutions', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let fixtures: PlatformFixtures;
  let admin: string;
  const societies: string[] = [];

  const call = (method: Method, path: string, token: string, body: object = {}) => {
    const http = request(t.app.getHttpServer());
    return http[method](path)
      .set('Authorization', `Bearer ${token}`)
      .send(method === 'get' || method === 'delete' ? undefined : body);
  };
  const result = async (pending: ReturnType<typeof call>) => {
    const res = await pending;
    return { status: res.status, body: res.body as Body };
  };
  const asAdmin = (method: Method, path: string, body: object = {}) =>
    result(call(method, path, admin, body));

  const read = (token: string, id: string) => result(call('get', `/v1/institutions/${id}`, token));
  const listAll = (query: string) => asAdmin('get', `/v1/platform/institutions?${query}`);

  const society = async () => {
    const res = await asAdmin('post', '/v1/platform/societies', {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    expect(res.status).toBe(201);
    societies.push(res.body.data.id);
    return res.body.data.id;
  };

  /** Adds an Institution as Super Admin, or as `token` when given (an Owner adds to their own Society). */
  const institution = async (
    societyId: string,
    fields: Record<string, unknown> = {},
    token?: string,
  ) => {
    const body = {
      ...(token ? {} : { societyId }),
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
      ...fields,
    };
    const res = await result(call('post', '/v1/institutions', token ?? admin, body));
    expect(res.status).toBe(201);
    return res.body.data;
  };

  const audit = (institutionId: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      society_id: string;
      institution_id: string;
      reason: string | null;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`institution_id = ${institutionId}`);

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    fixtures = new PlatformFixtures(t, ownerDb);
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
    await fixtures.cleanup();
  });

  describe('who may call', () => {
    it('keeps the platform routes and the owner-only changes from anyone else', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const owner = await fixtures.owner(societyId);
      const adminOf = await fixtures.institutionAdmin(societyId, [inst.id]);
      const base = `/v1/platform/institutions/${inst.id}`;

      for (const token of [owner.token, adminOf.token]) {
        expect((await result(call('get', '/v1/platform/institutions', token))).status).toBe(403);
        expect(
          (await result(call('post', `${base}/pause`, token, { version: 1, reason: 'x' }))).status,
        ).toBe(403);
        expect((await result(call('post', `${base}/resume`, token, { version: 1 }))).status).toBe(
          403,
        );
      }
      for (const [method, path] of [
        ['post', '/v1/institutions'],
        ['patch', `/v1/institutions/${inst.id}`],
        ['delete', `/v1/institutions/${inst.id}`],
      ] as const) {
        const res = await result(call(method, path, adminOf.token));
        expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
      }
      expect((await request(t.app.getHttpServer()).get('/v1/institutions')).status).toBe(401);
    });
  });

  describe('INS-02 add', () => {
    it('lets an Owner add to their own Society: 201, whole resource, their stamps', async () => {
      const societyId = await society();
      const owner = await fixtures.owner(societyId);
      const res = await result(
        call('post', '/v1/institutions', owner.token, {
          name: 'Green Valley School',
          code: 'GVS',
          place: 'Bengaluru',
          boardCode: 1,
          affiliationNumber: 'AFF-1',
          gstin: '29ABCDE1234F1Z5',
          email: 'Office@GVS.example.org',
          phone: { countryCode: '91', number: '9876543210' },
          telephone: '080-1234567',
          address: { line1: '12 Lake Road', line2: null, pincode: '560001' },
          location: { latitude: 12.971599, longitude: 77.594566 },
        }),
      );
      expect(res.status).toBe(201);
      const person = {
        id: owner.person,
        displayName: expect.any(String),
        roleName: 'Society Owner',
      };
      expect(res.body.data).toEqual({
        id: expect.any(String),
        societyId,
        code: 'GVS',
        name: 'Green Valley School',
        place: 'Bengaluru',
        boardCode: 1,
        affiliationNumber: 'AFF-1',
        gstin: '29ABCDE1234F1Z5',
        email: 'office@gvs.example.org',
        phone: { countryCode: '91', number: '9876543210' },
        telephone: '080-1234567',
        address: { line1: '12 Lake Road', line2: null, pincode: '560001' },
        location: { latitude: 12.971599, longitude: 77.594566 },
        status: 1,
        accessPause: null,
        version: 1,
        createdBy: person,
        createdAt: expect.stringMatching(/Z$/),
        updatedBy: person,
        updatedAt: expect.stringMatching(/Z$/),
      });
      const [entry, ...rest] = await audit(res.body.data.id);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        action: 'institution.create',
        actor_user_id: owner.person,
        society_id: societyId,
        institution_id: res.body.data.id,
      });
    });

    it('shows empty optional fields as null, never missing', async () => {
      const inst = await institution(await society());
      expect(inst).toMatchObject({
        place: null,
        boardCode: null,
        affiliationNumber: null,
        gstin: null,
        email: null,
        phone: null,
        telephone: null,
        location: null,
        address: { line1: '12 Lake Road', line2: null, pincode: null },
      });
    });

    it('lets Super Admin add to any Society, and needs the Society named', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      expect(inst.societyId).toBe(societyId);
      expect(inst.createdBy).toMatchObject({ id: superAdmin.id, roleName: 'Super Admin' });
      const missingSociety = await asAdmin('post', '/v1/institutions', {
        name: 'X',
        code: 'X',
        address: { line1: 'a' },
      });
      expect(missingSociety.status).toBe(400);
      expect(missingSociety.body.errors).toContainEqual({
        field: 'societyId',
        code: 'REQUIRED',
        message: expect.any(String),
      });
    });

    it('does not let an Owner name a Society, even their own', async () => {
      const societyId = await society();
      const owner = await fixtures.owner(societyId);
      const res = await result(
        call('post', '/v1/institutions', owner.token, {
          societyId,
          name: 'X',
          code: 'X',
          address: { line1: 'a' },
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors).toContainEqual(
        expect.objectContaining({ field: 'societyId', code: 'FIELD_NOT_ALLOWED' }),
      );
    });

    it('answers 404 for an unknown Society and 409 INVALID_STATE for a deactivated one', async () => {
      const body = { name: 'X', code: 'X', address: { line1: 'a' } };
      const unknown = await asAdmin('post', '/v1/institutions', { ...body, societyId: missing });
      expect(unknown.status).toBe(404);
      const societyId = await society();
      await asAdmin('delete', `/v1/platform/societies/${societyId}`);
      const gone = await asAdmin('post', '/v1/institutions', { ...body, societyId });
      expect([gone.status, gone.body.code]).toEqual([409, 'INVALID_STATE']);
    });

    it('answers 409 DUPLICATE on the code within a Society, in any letter case, but not across Societies', async () => {
      const societyId = await society();
      await institution(societyId, { code: 'Gvs' });
      for (const code of ['Gvs', 'GVS', 'gvs']) {
        const res = await asAdmin('post', '/v1/institutions', {
          societyId,
          name: 'Other',
          code,
          address: { line1: 'a' },
        });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'DUPLICATE',
          errors: [{ field: 'code', code: 'DUPLICATE' }],
        });
      }
      await institution(await society(), { code: 'Gvs' });
    });

    it.each([
      ['no name', { code: 'X', address: { line1: 'a' } }, 'name', 'REQUIRED'],
      ['no address', { name: 'X', code: 'X' }, 'address', 'REQUIRED'],
      [
        'an address without a first line',
        { name: 'X', code: 'X', address: { line2: 'b' } },
        'address.line1',
        'INVALID_TYPE',
      ],
      [
        'a null first line',
        { name: 'X', code: 'X', address: { line1: null } },
        'address.line1',
        'INVALID_TYPE',
      ],
      [
        'a board code of 7',
        { name: 'X', code: 'X', address: { line1: 'a' }, boardCode: 7 },
        'boardCode',
        'INVALID_CODE',
      ],
      [
        'a board code as text',
        { name: 'X', code: 'X', address: { line1: 'a' }, boardCode: '1' },
        'boardCode',
        'INVALID_TYPE',
      ],
      [
        'a bad GSTIN',
        { name: 'X', code: 'X', address: { line1: 'a' }, gstin: '29abcde1234f1z5' },
        'gstin',
        'INVALID_FORMAT',
      ],
      [
        'a latitude over 90',
        { name: 'X', code: 'X', address: { line1: 'a' }, location: { latitude: 91, longitude: 0 } },
        'location.latitude',
        'OUT_OF_RANGE',
      ],
      [
        'a longitude without a latitude',
        { name: 'X', code: 'X', address: { line1: 'a' }, location: { longitude: 5 } },
        'location.latitude',
        'INVALID_TYPE',
      ],
      [
        '7 decimals in a coordinate',
        {
          name: 'X',
          code: 'X',
          address: { line1: 'a' },
          location: { latitude: 1.1234567, longitude: 0 },
        },
        'location.latitude',
        'INVALID_TYPE',
      ],
      [
        'an empty place',
        { name: 'X', code: 'X', address: { line1: 'a' }, place: '' },
        'place',
        'TOO_SHORT',
      ],
      [
        'a status',
        { name: 'X', code: 'X', address: { line1: 'a' }, status: 0 },
        'status',
        'FIELD_NOT_ALLOWED',
      ],
      [
        'an author',
        { name: 'X', code: 'X', address: { line1: 'a' }, createdBy: 'me' },
        'createdBy',
        'FIELD_NOT_ALLOWED',
      ],
      [
        'a bad phone',
        {
          name: 'X',
          code: 'X',
          address: { line1: 'a' },
          phone: { countryCode: '91', number: '12' },
        },
        'phone.number',
        'INVALID_FORMAT',
      ],
    ])('answers 400 for %s', async (_what, body, field, code) => {
      const societyId = await society();
      const res = await asAdmin('post', '/v1/institutions', { societyId, ...body });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors).toContainEqual(expect.objectContaining({ field, code }));
    });
  });

  describe('INS-01 the Institutions a caller reaches', () => {
    it('shows an Owner every active Institution of their Society by name, paused ones flagged', async () => {
      const societyId = await society();
      const other = await society();
      const zed = await institution(societyId, { name: 'zed School' });
      const alpha = await institution(societyId, { name: 'Alpha School' });
      const gone = await institution(societyId, { name: 'Gone School' });
      await institution(other, { name: 'Elsewhere' });
      await asAdmin('delete', `/v1/institutions/${gone.id}`);
      await asAdmin('post', `/v1/platform/institutions/${zed.id}/pause`, {
        version: 1,
        reason: 'Dues',
      });
      const owner = await fixtures.owner(societyId);

      const res = await result(call('get', '/v1/institutions', owner.token));
      expect(res.status).toBe(200);
      expect(res.body.meta).toBeNull();
      expect(ids(res)).toEqual([alpha.id, zed.id]);
      expect((res.body.data as unknown as Record<string, unknown>[])[1]).toEqual({
        id: zed.id,
        code: zed.code,
        name: 'zed School',
        place: null,
        boardCode: null,
        paused: true,
        createdBy: expect.objectContaining({ id: superAdmin.id }),
        createdAt: expect.any(String),
        updatedBy: expect.objectContaining({ id: superAdmin.id }),
        updatedAt: expect.any(String),
      });
    });

    it('shows an Institution Admin only the Institutions they hold', async () => {
      const societyId = await society();
      const a = await institution(societyId, { name: 'A School' });
      await institution(societyId, { name: 'B School' });
      const adminOf = await fixtures.institutionAdmin(societyId, [a.id]);
      expect(ids(await result(call('get', '/v1/institutions', adminOf.token)))).toEqual([a.id]);
    });
  });

  describe('INS-03 read', () => {
    it('shows an Owner and a granted Admin the Institution, and refuses outsiders with 404', async () => {
      const societyId = await society();
      const mine = await institution(societyId);
      const notGranted = await institution(societyId);
      const foreign = await institution(await society());
      const owner = await fixtures.owner(societyId);
      const adminOf = await fixtures.institutionAdmin(societyId, [mine.id]);

      expect((await read(owner.token, mine.id)).body.data).toEqual(mine);
      expect((await read(adminOf.token, mine.id)).status).toBe(200);
      for (const [token, id] of [
        [owner.token, foreign.id],
        [adminOf.token, notGranted.id],
        [owner.token, missing],
        [owner.token, 'nope'],
      ] as const) {
        const res = await read(token, id);
        expect([res.status, res.body.code]).toEqual([404, 'NOT_FOUND']);
      }
    });

    it('answers 404 for a deactivated Institution and 423 for a paused one', async () => {
      const societyId = await society();
      const gone = await institution(societyId);
      const paused = await institution(societyId);
      const owner = await fixtures.owner(societyId);
      await asAdmin('delete', `/v1/institutions/${gone.id}`);
      await asAdmin('post', `/v1/platform/institutions/${paused.id}/pause`, {
        version: 1,
        reason: 'Dues',
      });
      expect((await result(call('get', `/v1/institutions/${gone.id}`, owner.token))).status).toBe(
        404,
      );
      const res = await result(call('get', `/v1/institutions/${paused.id}`, owner.token));
      expect([res.status, res.body.code]).toEqual([423, 'ACCESS_PAUSED']);
    });
  });

  describe('INS-04 edit', () => {
    it('lets an Owner change named fields: version moves, stamps move, before and after are audited', async () => {
      const societyId = await society();
      const inst = await institution(societyId, { place: 'Old Town', telephone: '1' });
      const owner = await fixtures.owner(societyId);
      const res = await result(
        call('patch', `/v1/institutions/${inst.id}`, owner.token, {
          version: 1,
          name: 'Green Valley PU College',
          place: null,
          boardCode: 3,
          location: { latitude: 1.5, longitude: -2.25 },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        name: 'Green Valley PU College',
        place: null,
        boardCode: 3,
        telephone: '1',
        location: { latitude: 1.5, longitude: -2.25 },
        version: 2,
        code: inst.code,
        updatedBy: { id: owner.person, roleName: 'Society Owner' },
        createdBy: { id: superAdmin.id },
      });
      const entry = (await audit(inst.id)).find((row) => row.action === 'institution.update')!;
      expect(entry.old_values).toEqual({
        name: 'Green Valley School',
        place: 'Old Town',
        board_code: null,
        latitude: null,
        longitude: null,
      });
      expect(entry.new_values).toMatchObject({
        name: 'Green Valley PU College',
        place: null,
        board_code: 3,
        latitude: '1.500000',
      });
    });

    it('lets Super Admin edit any Institution', async () => {
      const inst = await institution(await society());
      const res = await asAdmin('patch', `/v1/institutions/${inst.id}`, {
        version: 1,
        name: 'Renamed',
      });
      expect([res.status, res.body.data.name]).toEqual([200, 'Renamed']);
    });

    it('replaces the address and phone as a whole, clears the phone with null, never the first line', async () => {
      const inst = await institution(await society(), {
        phone: { countryCode: '91', number: '9876543210' },
        address: { line1: 'A', line2: 'B', pincode: '1' },
      });
      const path = `/v1/institutions/${inst.id}`;
      const replaced = await asAdmin('patch', path, { version: 1, address: { line1: 'C' } });
      expect(replaced.body.data.address).toEqual({ line1: 'C', line2: null, pincode: null });
      const cleared = await asAdmin('patch', path, { version: 2, phone: null, location: null });
      expect(cleared.body.data).toMatchObject({ phone: null, location: null, version: 3 });
      for (const address of [null, { line2: 'x' }, { line1: '' }]) {
        expect((await asAdmin('patch', path, { version: 3, address })).status).toBe(400);
      }
    });

    it('writes nothing when nothing changes', async () => {
      const inst = await institution(await society());
      const res = await asAdmin('patch', `/v1/institutions/${inst.id}`, {
        version: 1,
        name: inst.name,
        address: { line1: '12 Lake Road' },
      });
      expect([res.status, res.body.data.version]).toEqual([200, 1]);
      expect(await audit(inst.id)).toHaveLength(1);
    });

    it('answers 409 VERSION_CONFLICT with the current version for a stale screen', async () => {
      const inst = await institution(await society());
      await asAdmin('patch', `/v1/institutions/${inst.id}`, { version: 1, name: 'New' });
      const res = await asAdmin('patch', `/v1/institutions/${inst.id}`, {
        version: 1,
        name: 'Late',
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'VERSION_CONFLICT', data: { currentVersion: 2 } });
    });

    it('refuses the code, Society, status, pause and stamps as fields, and a null name', async () => {
      const inst = await institution(await society());
      for (const field of ['code', 'societyId', 'status', 'accessPause', 'updatedBy', 'id']) {
        const res = await asAdmin('patch', `/v1/institutions/${inst.id}`, {
          version: 1,
          [field]: 'x',
        });
        expect(res.status).toBe(400);
        expect(res.body.errors).toContainEqual(
          expect.objectContaining({ field, code: 'FIELD_NOT_ALLOWED' }),
        );
      }
      expect(
        (await asAdmin('patch', `/v1/institutions/${inst.id}`, { version: 1, name: null })).status,
      ).toBe(400);
    });

    it('answers 404 to an Owner for another Society’s Institution and an unknown one, 409 to Super Admin for a deactivated one', async () => {
      const societyId = await society();
      const foreign = await institution(await society());
      const owner = await fixtures.owner(societyId);
      for (const id of [foreign.id, missing]) {
        expect(
          (
            await result(
              call('patch', `/v1/institutions/${id}`, owner.token, { version: 1, name: 'x' }),
            )
          ).status,
        ).toBe(404);
      }
      await asAdmin('delete', `/v1/institutions/${foreign.id}`);
      const res = await asAdmin('patch', `/v1/institutions/${foreign.id}`, {
        version: 2,
        name: 'x',
      });
      expect([res.status, res.body.code]).toEqual([409, 'INVALID_STATE']);
      expect((await asAdmin('patch', `/v1/institutions/${missing}`, { version: 1 })).status).toBe(
        404,
      );
    });
  });

  describe('INS-05 deactivate', () => {
    it('answers { id, status: 0 }, ends the Admin who held only that Institution and spares the one who holds another', async () => {
      const societyId = await society();
      const first = await institution(societyId);
      const second = await institution(societyId);
      const owner = await fixtures.owner(societyId);
      const onlyFirst = await fixtures.institutionAdmin(societyId, [first.id]);
      const both = await fixtures.institutionAdmin(societyId, [first.id, second.id]);

      const res = await result(call('delete', `/v1/institutions/${first.id}`, owner.token));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: first.id, status: 0 });

      const ended = await result(call('get', '/v1/me', onlyFirst.token));
      expect(ended.status).toBe(401);
      expect(ended.body).toMatchObject({
        code: 'SESSION_ENDED',
        data: { reason: 'admin_revoked' },
      });
      expect((await result(call('get', '/v1/me', both.token))).status).toBe(200);
      expect(ids(await result(call('get', '/v1/institutions', both.token)))).toEqual([second.id]);
      expect((await result(call('get', '/v1/me', owner.token))).status).toBe(200);

      const grants = await sql<{ n: number }>`
        select count(*)::int as n from role_assignments
        where institution_id = ${first.id} and revoked_by = ${owner.person} and revoke_reason = 'institution_deactivated'`.execute(
        ownerDb,
      );
      expect(grants.rows[0]!.n).toBe(2);
      const entry = (await audit(first.id)).find((row) => row.action === 'institution.deactivate')!;
      expect(entry).toMatchObject({ actor_user_id: owner.person, society_id: societyId });
      expect(entry.new_values).toEqual({ status: 0, grantsRevoked: 2 });
    });

    it('lets Super Admin deactivate, and answers 409 INVALID_STATE the second time (404 to an Owner)', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const owner = await fixtures.owner(societyId);
      expect((await asAdmin('delete', `/v1/institutions/${inst.id}`)).status).toBe(200);
      const again = await asAdmin('delete', `/v1/institutions/${inst.id}`);
      expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
      expect(
        (await result(call('delete', `/v1/institutions/${inst.id}`, owner.token))).status,
      ).toBe(404);
      expect((await asAdmin('delete', `/v1/institutions/${missing}`)).status).toBe(404);
      expect((await asAdmin('delete', '/v1/institutions/nope')).status).toBe(404);
    });

    it('does not let an Owner deactivate another Society’s Institution', async () => {
      const owner = await fixtures.owner(await society());
      const foreign = await institution(await society());
      expect(
        (await result(call('delete', `/v1/institutions/${foreign.id}`, owner.token))).status,
      ).toBe(404);
      expect(
        (await asAdmin('get', '/v1/platform/institutions?q=' + foreign.code)).body.meta,
      ).toMatchObject({ totalItems: 1 });
    });
  });

  describe('PLT-20 and PLT-21 pause and resume', () => {
    it('stops the Institution’s people on their next call, spares its Society, and resumes', async () => {
      const societyId = await society();
      const first = await institution(societyId);
      const second = await institution(societyId);
      const owner = await fixtures.owner(societyId);
      const onlyFirst = await fixtures.institutionAdmin(societyId, [first.id]);
      await call('post', '/v1/fixtures/owner-write', owner.token).expect(200);

      const paused = await asAdmin('post', `/v1/platform/institutions/${first.id}/pause`, {
        version: 1,
        reason: 'Annual fee unpaid',
      });
      expect(paused.status).toBe(200);
      expect(paused.body.data).toMatchObject({
        version: 2,
        accessPause: {
          pausedAt: expect.stringMatching(/Z$/),
          pausedBy: { id: superAdmin.id, roleName: 'Super Admin' },
          reason: 'Annual fee unpaid',
        },
      });
      // Its only Admin is stopped; the Owner still works, in the other Institution.
      const refused = await result(call('get', `/v1/institutions/${first.id}`, onlyFirst.token));
      expect([refused.status, refused.body.code]).toEqual([423, 'ACCESS_PAUSED']);
      expect((await result(call('get', `/v1/institutions/${second.id}`, owner.token))).status).toBe(
        200,
      );
      await call('post', '/v1/fixtures/owner-write', owner.token).expect(200);

      const resumed = await asAdmin('post', `/v1/platform/institutions/${first.id}/resume`, {
        version: 2,
      });
      expect(resumed.body.data).toMatchObject({ accessPause: null, version: 3 });
      expect(
        (await result(call('get', `/v1/institutions/${first.id}`, onlyFirst.token))).status,
      ).toBe(200);

      const entries = await audit(first.id);
      expect(entries.find((row) => row.action === 'access.pause')).toMatchObject({
        reason: 'Annual fee unpaid',
        actor_user_id: superAdmin.id,
        society_id: societyId,
      });
      expect(entries.map((row) => row.action)).toContain('access.resume');
    });

    it('refuses a second pause, a resume that is not paused, a stale version and a deactivated Institution', async () => {
      const inst = await institution(await society());
      const base = `/v1/platform/institutions/${inst.id}`;
      const early = await asAdmin('post', `${base}/resume`, { version: 1 });
      expect([early.status, early.body.code]).toEqual([409, 'INVALID_STATE']);
      await asAdmin('post', `${base}/pause`, { version: 1, reason: 'Dues' });
      const again = await asAdmin('post', `${base}/pause`, { version: 2, reason: 'Again' });
      expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
      const stale = await asAdmin('post', `${base}/resume`, { version: 1 });
      expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', data: { currentVersion: 2 } });
      await asAdmin('delete', `/v1/institutions/${inst.id}`);
      for (const [path, body] of [
        [`${base}/resume`, { version: 3 }],
        [`${base}/pause`, { version: 3, reason: 'x' }],
      ] as const) {
        const res = await asAdmin('post', path, body);
        expect([res.status, res.body.code]).toEqual([409, 'INVALID_STATE']);
      }
    });

    it('needs a reason of 1 to 500 characters and the version, and answers 404 for an unknown one', async () => {
      const inst = await institution(await society());
      const base = `/v1/platform/institutions/${inst.id}`;
      for (const body of [
        { version: 1 },
        { version: 1, reason: '' },
        { version: 1, reason: 'r'.repeat(501) },
        { reason: 'x' },
      ]) {
        expect((await asAdmin('post', `${base}/pause`, body)).status).toBe(400);
      }
      expect((await asAdmin('post', `${base}/resume`, {})).status).toBe(400);
      expect(
        (
          await asAdmin('post', `/v1/platform/institutions/${missing}/pause`, {
            version: 1,
            reason: 'x',
          })
        ).status,
      ).toBe(404);
      expect(
        (await asAdmin('post', '/v1/platform/institutions/nope/resume', { version: 1 })).status,
      ).toBe(404);
    });
  });

  describe('PLT-19 list', () => {
    it('pages, filters and sorts across Societies', async () => {
      const tag = newId().slice(-8);
      const s1 = await society();
      const s2 = await society();
      const a = await institution(s1, { name: `Alpha ${tag}`, code: `a-${tag}` });
      const b = await institution(s2, { name: `beta ${tag}`, code: `B-${tag}` });
      const c = await institution(s1, { name: `Gamma ${tag}`, code: `c-${tag}` });
      await asAdmin('post', `/v1/platform/institutions/${c.id}/pause`, {
        version: 1,
        reason: 'Dues',
      });
      await asAdmin('delete', `/v1/institutions/${b.id}`);

      const found = await listAll(`q=${tag}`);
      expect(found.status).toBe(200);
      expect(ids(found)).toEqual([a.id, b.id, c.id]);
      expect(found.body.meta).toEqual({ page: 1, limit: 20, totalItems: 3, totalPages: 1 });
      expect((found.body.data as unknown as Record<string, unknown>[])[0]).toEqual({
        id: a.id,
        societyId: s1,
        societyName: 'Sunrise Trust',
        code: `a-${tag}`,
        name: `Alpha ${tag}`,
        place: null,
        boardCode: null,
        status: 1,
        paused: false,
        createdBy: expect.objectContaining({ id: superAdmin.id }),
        createdAt: expect.any(String),
        updatedBy: expect.objectContaining({ id: superAdmin.id }),
        updatedAt: expect.any(String),
      });
      expect(ids(await listAll(`q=${tag}&societyId=${s2}`))).toEqual([b.id]);
      expect(ids(await listAll(`q=${tag}&status=0`))).toEqual([b.id]);
      expect(ids(await listAll(`q=${tag}&status=0&status=1`))).toHaveLength(3);
      expect(ids(await listAll(`q=${tag}&paused=true`))).toEqual([c.id]);
      expect(ids(await listAll(`q=${tag}&paused=false&status=1`))).toEqual([a.id]);
      expect(ids(await listAll(`q=${tag}&sort=-name`))).toEqual([c.id, b.id, a.id]);
      expect(ids(await listAll(`q=${tag}&sort=code`))).toEqual([a.id, b.id, c.id]);
      expect(ids(await listAll(`q=${tag}&sort=-createdAt`))).toEqual([c.id, b.id, a.id]);
      const second = await listAll(`q=${tag}&limit=2&page=2`);
      expect(ids(second)).toEqual([c.id]);
      expect(second.body.meta).toEqual({ page: 2, limit: 2, totalItems: 3, totalPages: 2 });
    });

    it('answers 400 for an unknown sort, a bad status, a bad Society ID and a short search', async () => {
      expect((await listAll('sort=gstin')).body.code).toBe('INVALID_SORT');
      for (const query of ['status=2', 'paused=maybe', 'societyId=nope']) {
        expect((await listAll(query)).body.code).toBe('VALIDATION_FAILED');
      }
      expect((await listAll('q=a')).body.errors).toContainEqual(
        expect.objectContaining({ field: 'q', code: 'TOO_SHORT' }),
      );
    });
  });
});
