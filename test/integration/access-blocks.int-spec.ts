import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller, type Body } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { removeScratchSocieties } from '../support/scratch-society.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const missing = '00000000-0000-7000-8000-00000000ffff';
const BLOCKS = '/v1/platform/access-blocks';

type Method = 'get' | 'post' | 'patch' | 'delete';

const ids = (res: { body: Body }) =>
  (res.body.data as unknown as { id: string }[]).map((row) => row.id);

describe('PLT-42 to PLT-44 and SOC-02 section blocks (API design 6.5, 10.4e)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const owners = new Map<string, SignedInPerson>();
  const extraPeople: string[] = [];

  const asAdmin = (method: Method, path: string, body: object = {}) =>
    api(method, path, admin, body);

  const ownerOf = async (societyId: string) => {
    let owner = owners.get(societyId);
    if (!owner) {
      owner = await fixtures.owner(societyId);
      owners.set(societyId, owner);
    }
    return owner;
  };

  const society = async () => {
    const res = await asAdmin('post', '/v1/platform/societies', {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    expect(res.status).toBe(201);
    societies.push(res.body.data.id);
    return res.body.data.id;
  };

  const institution = async (societyId: string) => {
    const owner = await ownerOf(societyId);
    const res = await api('post', '/v1/institutions', owner.token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
    });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  const block = (section: string, societyId: string, institutionId?: string, reason = 'Dues') =>
    asAdmin('post', BLOCKS, { section, societyId, institutionId, reason });

  const audit = (entityId: string) =>
    readAuditRows<{
      action: string;
      actor_user_id: string;
      society_id: string;
      institution_id: string | null;
      reason: string | null;
      new_values: Record<string, unknown> | null;
    }>(ownerDb, sql`entity_id = ${entityId}`);

  /** A person with no grant yet; the test gives them one. */
  const person = async () => {
    const id = newId();
    extraPeople.push(id);
    const email = `${id}@two-worlds.test`;
    await sql`insert into users (id, email) values (${id}, ${email})`.execute(ownerDb);
    return { id, email };
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
    owners.clear();
    await fixtures.cleanup();
    for (const id of extraPeople.splice(0)) {
      await sql`delete from users where id = ${id}`.execute(ownerDb);
    }
  });

  describe('who may call', () => {
    it('keeps the platform routes from Owners and Admins, and SOC-02 from Super Admin and Admins', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const owner = await ownerOf(societyId);
      const adminOf = await fixtures.institutionAdmin(societyId, [inst.id]);

      for (const token of [owner.token, adminOf.token]) {
        for (const [method, path] of [
          ['post', BLOCKS],
          ['get', BLOCKS],
          ['delete', `${BLOCKS}/${missing}`],
        ] as const) {
          const res = await api(method, path, token);
          expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
        }
      }
      for (const token of [admin, adminOf.token]) {
        const res = await api('get', '/v1/society/access-blocks', token);
        expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
      }
      expect((await request(t.app.getHttpServer()).get(BLOCKS)).status).toBe(401);
    });
  });

  describe('PLT-42 block', () => {
    it('blocks the Owners: 201 with the whole resource, the audit entry with the Society, and the Owner’s next call is 423', async () => {
      const societyId = await society();
      const owner = await ownerOf(societyId);
      expect((await api('post', '/v1/fixtures/owner-write', owner.token)).status).toBe(200);

      const res = await block('owners', societyId, undefined, 'Annual fee unpaid');
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        id: expect.any(String),
        section: 'owners',
        societyId,
        institutionId: null,
        reason: 'Annual fee unpaid',
        blockedAt: expect.stringMatching(/Z$/),
        blockedBy: { id: superAdmin.id, displayName: expect.any(String), roleName: 'Super Admin' },
      });
      const [entry, ...rest] = await audit(res.body.data.id);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        action: 'access.block',
        actor_user_id: superAdmin.id,
        society_id: societyId,
        institution_id: null,
        reason: 'Annual fee unpaid',
      });

      const refused = await api('post', '/v1/fixtures/owner-write', owner.token);
      expect([refused.status, refused.body.code, refused.body.data]).toEqual([
        423,
        'SECTION_BLOCKED',
        { section: 'owners' },
      ]);
      // The 423 never carries the reason; the Owner reads it through SOC-02.
      expect(JSON.stringify(refused.body)).not.toContain('Annual fee unpaid');
      expect((await api('get', '/v1/me', owner.token)).status).toBe(200);
      expect((await api('get', '/v1/fixtures/owner-read-when-blocked', owner.token)).status).toBe(
        200,
      );
    });

    it('stops the Owners of that Society only: its Admins and another Society’s Owners keep working', async () => {
      const societyId = await society();
      const other = await society();
      const inst = await institution(societyId);
      const adminOf = await fixtures.institutionAdmin(societyId, [inst.id]);
      const otherOwner = await ownerOf(other);
      await block('owners', societyId);
      expect((await api('get', `/v1/institutions/${inst.id}`, adminOf.token)).status).toBe(200);
      expect((await api('post', '/v1/fixtures/owner-write', otherOwner.token)).status).toBe(200);
    });

    it('blocks the staff of one Institution: its only Admin is stopped, the Owner and another Institution’s Admin are not', async () => {
      const societyId = await society();
      const first = await institution(societyId);
      const second = await institution(societyId);
      const owner = await ownerOf(societyId);
      const onlyFirst = await fixtures.institutionAdmin(societyId, [first.id]);
      const onlySecond = await fixtures.institutionAdmin(societyId, [second.id]);
      const both = await fixtures.institutionAdmin(societyId, [first.id, second.id]);

      const res = await block('staff', societyId, first.id, 'Staff dues');
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ section: 'staff', institutionId: first.id });
      const entry = (await audit(res.body.data.id))[0]!;
      expect([entry.society_id, entry.institution_id]).toEqual([societyId, first.id]);

      const stopped = await api('get', `/v1/institutions/${first.id}`, onlyFirst.token);
      expect([stopped.status, stopped.body.code, stopped.body.data]).toEqual([
        423,
        'SECTION_BLOCKED',
        { section: 'staff' },
      ]);
      expect((await api('get', '/v1/me', onlyFirst.token)).status).toBe(200);
      // With another Institution open the Admin passes, and 423 is only for the blocked one.
      expect((await api('get', `/v1/institutions/${second.id}`, both.token)).status).toBe(200);
      expect((await api('get', `/v1/institutions/${first.id}`, both.token)).status).toBe(423);
      expect((await api('get', `/v1/institutions/${second.id}`, onlySecond.token)).status).toBe(
        200,
      );
      expect((await api('get', `/v1/institutions/${first.id}`, owner.token)).status).toBe(200);
      expect((await api('post', '/v1/fixtures/owner-write', owner.token)).status).toBe(200);
    });

    it('records a students block without stopping the Owner or the staff', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const owner = await ownerOf(societyId);
      const adminOf = await fixtures.institutionAdmin(societyId, [inst.id]);
      const res = await block('students', societyId, inst.id);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ section: 'students', institutionId: inst.id });
      expect((await api('post', '/v1/fixtures/owner-write', owner.token)).status).toBe(200);
      expect((await api('get', `/v1/institutions/${inst.id}`, adminOf.token)).status).toBe(200);
    });

    it('answers 409 DUPLICATE for a second active block of the same section, and allows it again after the lift', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      for (const [section, institutionId] of [
        ['owners', undefined],
        ['staff', inst.id],
        ['students', inst.id],
      ] as const) {
        const first = await block(section, societyId, institutionId);
        expect(first.status).toBe(201);
        const again = await block(section, societyId, institutionId, 'Again');
        expect([again.status, again.body.code]).toEqual([409, 'DUPLICATE']);
        expect(again.body.errors).toContainEqual(
          expect.objectContaining({ field: 'section', code: 'DUPLICATE' }),
        );
        expect((await asAdmin('delete', `${BLOCKS}/${first.body.data.id}`)).status).toBe(200);
        expect((await block(section, societyId, institutionId)).status).toBe(201);
      }
    });

    it('lets one of two parallel identical blocks in and refuses the other', async () => {
      const societyId = await society();
      const answers = await Promise.all([block('owners', societyId), block('owners', societyId)]);
      expect(answers.map((answer) => answer.status).toSorted()).toEqual([201, 409]);
      const listed = await asAdmin('get', `${BLOCKS}?societyId=${societyId}`);
      expect(listed.body.meta).toMatchObject({ totalItems: 1 });
    });

    it.each([
      ['an unknown section', { section: 'teachers' }, 'section', 'INVALID_CODE'],
      ['no section', {}, 'section', 'INVALID_CODE'],
      ['no reason', { section: 'owners' }, 'reason', 'INVALID_TYPE'],
      ['a blank reason', { section: 'owners', reason: '   ' }, 'reason', 'TOO_SHORT'],
      [
        'a reason of 501 characters',
        { section: 'owners', reason: 'r'.repeat(501) },
        'reason',
        'TOO_LONG',
      ],
      [
        'a bad Society ID',
        { section: 'owners', reason: 'x', societyId: 'nope' },
        'societyId',
        'INVALID_FORMAT',
      ],
    ])('answers 400 for %s', async (_what, extra, field, code) => {
      const societyId = await society();
      const body = { societyId, ...extra };
      const res = await asAdmin('post', BLOCKS, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors).toContainEqual(expect.objectContaining({ field, code }));
    });

    it('pairs the Institution with the section: owners take none, staff and students need one', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const withOne = await block('owners', societyId, inst.id);
      expect(withOne.status).toBe(400);
      expect(withOne.body.errors).toContainEqual(
        expect.objectContaining({ field: 'institutionId', code: 'FIELD_NOT_ALLOWED' }),
      );
      for (const section of ['staff', 'students']) {
        const without = await block(section, societyId);
        expect(without.status).toBe(400);
        expect(without.body.errors).toContainEqual(
          expect.objectContaining({ field: 'institutionId', code: 'REQUIRED' }),
        );
      }
    });

    it('answers 404 for an unknown Society or Institution, and for an Institution of another Society', async () => {
      const societyId = await society();
      const other = await society();
      const foreign = await institution(other);
      expect((await block('owners', missing)).status).toBe(404);
      expect((await block('staff', societyId, missing)).status).toBe(404);
      expect((await block('staff', societyId, foreign.id)).status).toBe(404);
    });

    it('answers 409 INVALID_STATE for a deactivated Society or Institution', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const owner = await ownerOf(societyId);
      await api('delete', `/v1/institutions/${inst.id}`, owner.token);
      const staff = await block('staff', societyId, inst.id);
      expect([staff.status, staff.body.code]).toEqual([409, 'INVALID_STATE']);
      await asAdmin('delete', `/v1/platform/societies/${societyId}`);
      const ownersBlock = await block('owners', societyId);
      expect([ownersBlock.status, ownersBlock.body.code]).toEqual([409, 'INVALID_STATE']);
    });
  });

  describe('PLT-43 lift', () => {
    it('answers { id, status: 0 }, keeps the row as history, audits it, and lets the Owner work on the next call', async () => {
      const societyId = await society();
      const owner = await ownerOf(societyId);
      const blocked = await block('owners', societyId);
      expect((await api('post', '/v1/fixtures/owner-write', owner.token)).status).toBe(423);

      const id = blocked.body.data.id;
      const res = await asAdmin('delete', `${BLOCKS}/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id, status: 0 });
      expect((await api('post', '/v1/fixtures/owner-write', owner.token)).status).toBe(200);

      // The row stays as history; the table owner reads it as Super Admin.
      const rows = await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        return sql<{ lifted_by: string; lifted_at: Date | null }>`
          select lifted_by, lifted_at from access_blocks where id = ${id}`.execute(tx);
      });
      expect(rows.rows[0]).toMatchObject({ lifted_by: superAdmin.id });
      expect(rows.rows[0]!.lifted_at).toBeInstanceOf(Date);

      const entries = await audit(id);
      expect(entries.map((entry) => entry.action).toSorted()).toEqual([
        'access.block',
        'access.unblock',
      ]);
      expect(entries.find((entry) => entry.action === 'access.unblock')).toMatchObject({
        actor_user_id: superAdmin.id,
        society_id: societyId,
      });
    });

    it('answers 404 for an unknown block, a malformed ID, and one already lifted', async () => {
      const societyId = await society();
      const blocked = await block('owners', societyId);
      expect((await asAdmin('delete', `${BLOCKS}/${blocked.body.data.id}`)).status).toBe(200);
      for (const id of [blocked.body.data.id, missing, 'nope']) {
        const res = await asAdmin('delete', `${BLOCKS}/${id}`);
        expect([res.status, res.body.code]).toEqual([404, 'NOT_FOUND']);
      }
    });

    it('gives one 200, one 404 and one audit entry when two lifts race', async () => {
      const societyId = await society();
      const blocked = await block('owners', societyId);
      const id = blocked.body.data.id;
      const answers = await Promise.all([
        asAdmin('delete', `${BLOCKS}/${id}`),
        asAdmin('delete', `${BLOCKS}/${id}`),
      ]);
      expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 404]);
      const lifts = (await audit(id)).filter((entry) => entry.action === 'access.unblock');
      expect(lifts).toHaveLength(1);
    });

    it('lifts the staff block of one Institution and leaves the other block in force', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const adminOf = await fixtures.institutionAdmin(societyId, [inst.id]);
      const staff = await block('staff', societyId, inst.id);
      await block('students', societyId, inst.id);
      expect((await api('get', `/v1/institutions/${inst.id}`, adminOf.token)).status).toBe(423);
      await asAdmin('delete', `${BLOCKS}/${staff.body.data.id}`);
      expect((await api('get', `/v1/institutions/${inst.id}`, adminOf.token)).status).toBe(200);
      const left = await asAdmin('get', `${BLOCKS}?societyId=${societyId}`);
      expect(
        (left.body.data as unknown as { section: string }[]).map((row) => row.section),
      ).toEqual(['students']);
    });
  });

  describe('PLT-44 list', () => {
    it('lists the active blocks, newest first, with filters and paging, and not the lifted ones', async () => {
      const tag = newId().slice(-8);
      const s1 = await society();
      const s2 = await society();
      const inst = await institution(s1);
      const a = await block('owners', s1, undefined, `Fees ${tag}`);
      const b = await block('staff', s1, inst.id, `Staff ${tag}`);
      const c = await block('owners', s2, undefined, `Other ${tag}`);
      const lifted = await block('students', s1, inst.id, `Lifted ${tag}`);
      await asAdmin('delete', `${BLOCKS}/${lifted.body.data.id}`);

      const found = await asAdmin('get', `${BLOCKS}?q=${tag}`);
      expect(found.status).toBe(200);
      expect(ids(found)).toEqual([c.body.data.id, b.body.data.id, a.body.data.id]);
      expect(found.body.meta).toEqual({ page: 1, limit: 20, totalItems: 3, totalPages: 1 });
      expect(ids(await asAdmin('get', `${BLOCKS}?q=${tag}&sort=blockedAt`))).toEqual([
        a.body.data.id,
        b.body.data.id,
        c.body.data.id,
      ]);
      expect(ids(await asAdmin('get', `${BLOCKS}?societyId=${s2}`))).toEqual([c.body.data.id]);
      expect(ids(await asAdmin('get', `${BLOCKS}?institutionId=${inst.id}`))).toEqual([
        b.body.data.id,
      ]);
      expect(ids(await asAdmin('get', `${BLOCKS}?q=${tag}&section=owners`))).toEqual([
        c.body.data.id,
        a.body.data.id,
      ]);
      expect(
        ids(await asAdmin('get', `${BLOCKS}?q=${tag}&section=owners&section=staff`)),
      ).toHaveLength(3);
      const second = await asAdmin('get', `${BLOCKS}?q=${tag}&limit=2&page=2`);
      expect(ids(second)).toEqual([a.body.data.id]);
      expect(second.body.meta).toEqual({ page: 2, limit: 2, totalItems: 3, totalPages: 2 });
    });

    it('answers 400 for an unknown sort, section or Society ID, and a short search', async () => {
      expect((await asAdmin('get', `${BLOCKS}?sort=reason`)).body.code).toBe('INVALID_SORT');
      for (const query of ['section=teachers', 'societyId=nope', 'institutionId=nope']) {
        expect((await asAdmin('get', `${BLOCKS}?${query}`)).body.code).toBe('VALIDATION_FAILED');
      }
      expect((await asAdmin('get', `${BLOCKS}?q=a`)).body.errors).toContainEqual(
        expect.objectContaining({ field: 'q', code: 'TOO_SHORT' }),
      );
    });
  });

  describe('SOC-02 an Owner reads the blocks of their Society', () => {
    it('shows the active blocks with the reason and the Institution’s name, while the Owners are blocked, and not another Society’s', async () => {
      const societyId = await society();
      const other = await society();
      const inst = await institution(societyId);
      const owner = await ownerOf(societyId);
      await block('owners', other, undefined, 'Not yours');
      expect((await api('get', '/v1/society/access-blocks', owner.token)).body.data).toEqual([]);

      const ownersBlock = await block('owners', societyId, undefined, 'Annual fee unpaid');
      const staff = await block('staff', societyId, inst.id, 'Staff dues');
      const lifted = await block('students', societyId, inst.id, 'Old');
      await asAdmin('delete', `${BLOCKS}/${lifted.body.data.id}`);

      // The Owners are blocked, and this route is one the block leaves open.
      const res = await api('get', '/v1/society/access-blocks', owner.token);
      expect(res.status).toBe(200);
      expect(res.body.meta).toBeNull();
      expect(res.body.data).toEqual([
        {
          id: ownersBlock.body.data.id,
          section: 'owners',
          institutionId: null,
          institutionName: null,
          reason: 'Annual fee unpaid',
          blockedAt: expect.stringMatching(/Z$/),
        },
        {
          id: staff.body.data.id,
          section: 'staff',
          institutionId: inst.id,
          institutionName: 'Green Valley School',
          reason: 'Staff dues',
          blockedAt: expect.stringMatching(/Z$/),
        },
      ]);
    });
  });

  describe('the request gate does not depend on what the caller can read', () => {
    it('stops an Institution Admin who cannot read a single block, because row-level security hides them', async () => {
      const societyId = await society();
      const inst = await institution(societyId);
      const adminOf = await fixtures.institutionAdmin(societyId, [inst.id]);
      await block('staff', societyId, inst.id);
      const seen = await database.transaction(
        { societyId, roleCode: 3, personId: adminOf.person, institutionIds: [inst.id] },
        (tx) => tx.selectFrom('access_blocks').selectAll().execute(),
      );
      expect(seen).toEqual([]);
      expect((await api('get', `/v1/institutions/${inst.id}`, adminOf.token)).status).toBe(423);
    });

    it('keeps another context: an Admin blocked in one Society works in the other, and the app is told which is blocked', async () => {
      const first = await society();
      const second = await society();
      const firstInst = await institution(first);
      const secondInst = await institution(second);
      const { id, email } = await person();
      for (const [societyId, institutionId] of [
        [first, firstInst.id],
        [second, secondInst.id],
      ]) {
        await sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
          values (${id}, 3, ${societyId}, ${institutionId}, gen_random_uuid())`.execute(ownerDb);
      }
      await block('staff', first, firstInst.id);

      const login = await signInMobile(t, email);
      expect(
        login.contexts
          .map((c) => [c.societyId, c.isBlocked] as const)
          .toSorted(([x], [y]) => String(x).localeCompare(String(y))),
      ).toEqual(
        [
          [first, true],
          [second, false],
        ].toSorted(([x], [y]) => String(x).localeCompare(String(y))),
      );

      const switchTo = (token: string, societyId: string) =>
        request(t.app.getHttpServer())
          .post('/v1/auth/context')
          .set('Authorization', `Bearer ${token}`)
          .send({ roleCode: 3, societyId });
      const inFirst = (await switchTo(login.accessToken, first).expect(200)).body.data;
      expect(inFirst.activeContext).toMatchObject({ societyId: first, isBlocked: true });
      expect(
        (await api('get', `/v1/institutions/${firstInst.id}`, inFirst.accessToken)).status,
      ).toBe(423);
      expect((await api('get', '/v1/me', inFirst.accessToken)).status).toBe(200);

      const inSecond = (await switchTo(inFirst.accessToken, second).expect(200)).body.data;
      expect(inSecond.activeContext).toMatchObject({ societyId: second, isBlocked: false });
      expect(
        (await api('get', `/v1/institutions/${secondInst.id}`, inSecond.accessToken)).status,
      ).toBe(200);
    });

    it('counts a block only against the Institution it names: an Admin of two Institutions is stopped only when both are blocked', async () => {
      const societyId = await society();
      const first = await institution(societyId);
      const second = await institution(societyId);
      const { id, email } = await person();
      for (const institutionId of [first.id, second.id]) {
        await sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
          values (${id}, 3, ${societyId}, ${institutionId}, gen_random_uuid())`.execute(ownerDb);
      }
      const blockedInChooser = async () =>
        (await signInMobile(t, email)).contexts.find((c) => c.societyId === societyId)?.isBlocked;

      await block('staff', societyId, second.id);
      expect(await blockedInChooser()).toBe(false);
      await block('staff', societyId, first.id);
      expect(await blockedInChooser()).toBe(true);
    });
  });

  describe('row-level security and the definer functions', () => {
    it('lets the app read blocks only through the Owner’s policy, and never write them as an Owner', async () => {
      const societyId = await society();
      await block('owners', societyId);
      const owner = await ownerOf(societyId);
      const ownerTenant = { societyId, roleCode: 2, personId: owner.person };
      const rows = await database.transaction(ownerTenant, (tx) =>
        tx.selectFrom('access_blocks').select('section').execute(),
      );
      expect(rows).toEqual([{ section: 1 }]);
      await expect(
        database.transaction(ownerTenant, (tx) =>
          tx
            .insertInto('access_blocks')
            .values({ society_id: societyId, section: 1, reason: 'x', created_by: owner.person })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      const lift = await database.transaction(ownerTenant, (tx) =>
        tx
          .updateTable('access_blocks')
          .set({ lifted_at: new Date(), lifted_by: owner.person })
          .executeTakeFirst(),
      );
      expect(lift.numUpdatedRows).toBe(0n);
    });

    it('lets the app role lift a block and rewrite nothing that says what was blocked or why', async () => {
      const { rows } = await sql<{ column_name: string; can_update: boolean }>`
        select column_name::text as column_name,
          has_column_privilege('erp_app', 'access_blocks', column_name::text, 'update') as can_update
        from information_schema.columns
        where table_name = 'access_blocks' and table_schema = 'public'
        order by column_name`.execute(ownerDb);
      const updatable = rows.filter((row) => row.can_update).map((row) => row.column_name);
      expect(updatable).toEqual(['lifted_at', 'lifted_by', 'updated_at', 'updated_by']);
    });

    it('shows an Owner nothing of another Society’s blocks', async () => {
      const mine = await society();
      const theirs = await society();
      await block('owners', theirs);
      const owner = await ownerOf(mine);
      const rows = await database.transaction(
        { societyId: mine, roleCode: 2, personId: owner.person },
        (tx) => tx.selectFrom('access_blocks').select('section').execute(),
      );
      expect(rows).toEqual([]);
      expect((await api('get', '/v1/society/access-blocks', owner.token)).body.data).toEqual([]);
    });

    it('keeps the definer functions from the public and open to the app role only', async () => {
      const { rows } = await sql<{ name: string; owner_only: boolean; app_can: boolean }>`
        select proname as name, proacl::text !~ '(^|[{,])=' as owner_only,
          has_function_privilege('erp_app', oid, 'execute') as app_can
        from pg_proc where proname in ('app_active_blocks', 'app_society_name') order by proname`.execute(
        ownerDb,
      );
      expect(rows).toEqual([
        { name: 'app_active_blocks', owner_only: true, app_can: true },
        { name: 'app_society_name', owner_only: true, app_can: true },
      ]);
    });

    it('answers only for a person who holds a grant in the Society, and puts the role setting back', async () => {
      const societyId = await society();
      const owner = await ownerOf(societyId);
      await block('owners', societyId);
      const stranger = await person();
      const read = (personId: string) =>
        database.transaction({ roleCode: 2 }, async (tx) => {
          const blocks = await sql<{ section: number }>`
            select section from app_active_blocks(${societyId}::uuid, ${personId}::uuid)`.execute(
            tx,
          );
          const name = await sql<{ name: string | null }>`
            select app_society_name(${societyId}::uuid, ${personId}::uuid) as name`.execute(tx);
          const role = await sql<{ role: string }>`
            select current_setting('app.role_code') as role`.execute(tx);
          return { blocks: blocks.rows, name: name.rows[0]!.name, role: role.rows[0]!.role };
        });
      expect(await read(owner.person)).toEqual({
        blocks: [{ section: 1 }],
        name: 'Sunrise Trust',
        role: '2',
      });
      expect(await read(stranger.id)).toEqual({ blocks: [], name: null, role: '2' });
    });
  });

  describe('the migration', () => {
    it('rolls back and forward again, and Society and Institution writes still work after', async () => {
      const result = await runMigrations(migrationUrl, 'down');
      expect(result.error).toBeUndefined();
      const afterDown = await sql<{ n: number }>`
        select count(*)::int as n from information_schema.columns
        where table_name = 'societies' and column_name = 'access_paused_at'`.execute(ownerDb);
      expect(afterDown.rows[0]!.n).toBe(1);
      await runMigrations(migrationUrl, 'latest');

      const societyId = newId();
      societies.push(societyId);
      await ownerDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.role_code', '1', true)`.execute(tx);
        await sql`insert into societies (id, name, code) values (${societyId}, 'Roundtrip', ${societyId})`.execute(
          tx,
        );
        await sql`insert into institutions (society_id, name, code, address_line_1)
          values (${societyId}, 'Inst', 'RT', '1 Road')`.execute(tx);
        await sql`update societies set description = 'x' where id = ${societyId}`.execute(tx);
        await sql`update institutions set name = 'Inst2' where society_id = ${societyId}`.execute(
          tx,
        );
        await sql`insert into access_blocks (society_id, section, reason, created_by)
          values (${societyId}, 1, 'x', ${superAdmin.id})`.execute(tx);
      });
    });
  });
});
