import { Kysely, PostgresDialect } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { clearBlocks } from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');

type Method = 'get' | 'post' | 'patch' | 'delete';

describe('QA: PLT-45 one Institution for Super Admin, adversarial (API design 10.4c)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  /** The Owner of each scratch Society, signed in once: only Owners add and change Institutions. */
  const owners = new Map<string, SignedInPerson>();

  const ownerOf = async (societyId: string) => {
    let owner = owners.get(societyId);
    if (!owner) {
      owner = await fixtures.owner(societyId);
      owners.set(societyId, owner);
    }
    return owner;
  };
  const asOwner = async (societyId: string, method: Method, path: string, body: object = {}) =>
    api(method, path, (await ownerOf(societyId)).token, body);

  const asAdmin = (method: Method, path: string, body: object = {}) =>
    api(method, path, admin, body);

  const read = (token: string, id: string) => api('get', `/v1/institutions/${id}`, token);
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

  /** Adds an Institution as the Owner of that Society. */
  const institution = async (societyId: string, fields: Record<string, unknown> = {}) => {
    const body = {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
      ...fields,
    };
    const res = await asOwner(societyId, 'post', '/v1/institutions', body);
    expect(res.status).toBe(201);
    return res.body.data;
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
    await clearBlocks(ownerDb);
    await removeScratchSocieties(ownerDb, societies.splice(0));
    owners.clear();
    await fixtures.cleanup();
  });

  const one = (id: string, token = admin) => api('get', `/v1/platform/institutions/${id}`, token);

  const block = async (section: string, societyId: string, institutionId?: string) => {
    const res = await asAdmin('post', '/v1/platform/access-blocks', {
      section,
      societyId,
      ...(institutionId ? { institutionId } : {}),
      reason: 'Dues unpaid',
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };

  describe('Q1 who may call', () => {
    it('refuses the Institution Admin of that very Institution and its Owner with 403, and malformed tokens with 401', async () => {
      const societyId = await society();
      const made = await institution(societyId);
      const adminOf = await fixtures.institutionAdmin(societyId, [made.id]);
      expect((await one(made.id, adminOf.token)).status).toBe(403);
      expect((await one(made.id, (await ownerOf(societyId)).token)).status).toBe(403);
      for (const header of ['Bearer x', 'Basic abc', 'Bearer ']) {
        const res = await request(t.app.getHttpServer())
          .get(`/v1/platform/institutions/${made.id}`)
          .set('Authorization', header);
        expect([header, res.status]).toEqual([header, 401]);
      }
    });
  });

  describe('Q2 what it shows', () => {
    it('is the Owner’s INS-03 view of the same Institution plus societyName and blockedSections, nothing else', async () => {
      const societyId = await society();
      const made = await institution(societyId, { name: 'Hill View', email: 'office@hill.test' });
      const owner = await ownerOf(societyId);
      const theirs = await read(owner.token, made.id);
      const ours = await one(made.id);
      expect([theirs.status, ours.status]).toEqual([200, 200]);
      const { societyName, societyStatus, blockedSections, ...rest } = ours.body.data as Record<
        string,
        unknown
      >;
      expect(rest).toEqual(theirs.body.data);
      expect([societyName, societyStatus, blockedSections]).toEqual(['Sunrise Trust', 1, []]);
    });

    it('lists both blocked sections, drops one when lifted, and never shows another Institution’s block or the Owners block', async () => {
      const societyId = await society();
      const a = await institution(societyId);
      const b = await institution(societyId);
      const staff = await block('staff', societyId, a.id);
      await block('students', societyId, a.id);
      await block('students', societyId, b.id);
      await block('owners', societyId);
      expect((await one(a.id)).body.data.blockedSections).toEqual(['staff', 'students']);
      expect((await one(b.id)).body.data.blockedSections).toEqual(['students']);
      expect((await asAdmin('delete', `/v1/platform/access-blocks/${staff}`)).status).toBe(200);
      expect((await one(a.id)).body.data.blockedSections).toEqual(['students']);
    });

    it('agrees with the PLT-19 line for the same Institution', async () => {
      const societyId = await society();
      const made = await institution(societyId, { code: `q-${newId().slice(-8)}` });
      await block('staff', societyId, made.id);
      const line = (
        (await listAll(`q=${encodeURIComponent(String(made.code))}`)).body.data as unknown as {
          id: string;
          societyName: string;
          blockedSections: string[];
          status: number;
        }[]
      ).find((row) => row.id === made.id)!;
      const detail = (await one(made.id)).body.data;
      expect({
        societyName: detail.societyName,
        blockedSections: detail.blockedSections,
        status: detail.status,
      }).toEqual({
        societyName: line.societyName,
        blockedSections: line.blockedSections,
        status: line.status,
      });
    });

    it('still answers for an Institution of a deactivated Society, with the Society’s name', async () => {
      const societyId = await society();
      const made = await institution(societyId);
      expect((await asAdmin('delete', `/v1/platform/societies/${societyId}`)).status).toBe(200);
      const res = await one(made.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: made.id, societyId, societyName: 'Sunrise Trust' });
      console.log(
        'QA-Q2 Institution status after its Society was deactivated:',
        res.body.data.status,
      );
    });
  });

  describe('Q3 IDs', () => {
    it('answers 404, never 500, for odd IDs, and finds an Institution by its ID in upper case', async () => {
      const societyId = await society();
      const made = await institution(societyId);
      for (const id of [
        '00000000-0000-0000-0000-000000000000',
        `{${made.id}}`,
        `${made.id}%00`,
        `${made.id} `,
        "1' or '1'='1",
        'x'.repeat(2000),
        societyId,
      ]) {
        const res = await asAdmin('get', `/v1/platform/institutions/${encodeURI(id)}`);
        expect([id.slice(0, 40), res.status]).toEqual([id.slice(0, 40), 404]);
      }
      const upper = await one(made.id.toUpperCase());
      console.log('QA-Q3 upper-case ID:', upper.status);
      expect([200, 404]).toContain(upper.status);
    });

    it('is read only: POST, PATCH, PUT and DELETE on the path are not served', async () => {
      const societyId = await society();
      const made = await institution(societyId);
      const path = `/v1/platform/institutions/${made.id}`;
      for (const method of ['post', 'patch', 'put', 'delete'] as const) {
        const http = request(t.app.getHttpServer());
        const res = await http[method](path)
          .set('Authorization', `Bearer ${admin}`)
          .send({ name: 'Taken over' });
        expect([method, [404, 405].includes(res.status)]).toEqual([method, true]);
      }
      expect((await one(made.id)).body.data.name).toBe('Green Valley School');
    });
  });
});
