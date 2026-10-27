import { Kysely, PostgresDialect, sql } from 'kysely';
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
const BLOCKS = '/v1/platform/access-blocks';

interface Loose {
  code?: string;
  data: {
    session: { activeContext: { isBlocked: boolean } | null };
    contexts: { societyId: string; isBlocked: boolean }[];
  } & { id: string }[];
}
/** The parts of an answer these tests read, typed loosely. */
const loose = (res: { body: unknown }) => res.body as Loose;

/** QA attacks on B10 section blocks (API design 6.5, 10.4e). */
describe('QA: section blocks', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let fixtures: PlatformFixtures;
  let admin: string;
  let api: ReturnType<typeof apiCaller>;
  const societies: string[] = [];
  const owners = new Map<string, SignedInPerson>();

  const ownerOf = async (societyId: string) => {
    let owner = owners.get(societyId);
    if (!owner) {
      owner = await fixtures.owner(societyId);
      owners.set(societyId, owner);
    }
    return owner;
  };
  const society = async () => {
    const res = await api('post', '/v1/platform/societies', admin, {
      name: 'QA Block Trust',
      code: `Q${newId().slice(-12)}`,
    });
    expect(res.status).toBe(201);
    societies.push(res.body.data.id);
    return res.body.data.id as string;
  };
  const institution = async (societyId: string) => {
    const res = await api('post', '/v1/institutions', (await ownerOf(societyId)).token, {
      name: 'QA School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '1 Road' },
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };
  const block = (body: object) => api('post', BLOCKS, admin, body);
  const activeBlocks = (societyId: string) =>
    ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      return (
        await sql<{ n: number }>`select count(*)::int as n from access_blocks
          where society_id = ${societyId} and lifted_at is null`.execute(tx)
      ).rows[0]!.n;
    });

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

  it('X1 an institutionId of null for staff or students is a 400, never a 500', async () => {
    const societyId = await society();
    const seen: string[] = [];
    for (const section of ['staff', 'students', 'owners']) {
      const res = await block({ section, societyId, institutionId: null, reason: 'Dues' });
      seen.push(
        `${section} ${res.status} ${res.body.code} ${JSON.stringify(res.body.errors ?? [])}`,
      );
    }
    console.log('X1', seen.join(' | '));
    expect(seen.every((line) => line.includes(' 400 '))).toBe(true);
    expect(await activeBlocks(societyId)).toBe(0);
  });

  it('X2 a reason of spaces only is a 400 on reason, never a 500', async () => {
    const societyId = await society();
    const res = await block({ section: 'owners', societyId, reason: '   ' });
    console.log('X2', res.status, res.body.code, JSON.stringify(res.body.errors ?? []));
    expect(res.status).toBe(400);
    expect(await activeBlocks(societyId)).toBe(0);
  });

  it('X3 an Admin whose only open Institution is staff-blocked (the other was closed): the context says blocked, as the gate does', async () => {
    const societyId = await society();
    const blocked = await institution(societyId);
    const closed = await institution(societyId);
    const adminOf = await fixtures.institutionAdmin(societyId, [blocked, closed]);
    const owner = await ownerOf(societyId);
    expect((await api('delete', `/v1/institutions/${closed}`, owner.token)).status).toBe(200);
    expect(
      (await block({ section: 'staff', societyId, institutionId: blocked, reason: 'Dues' })).status,
    ).toBe(201);

    const call = await api('get', '/v1/institutions', adminOf.token);
    const me = await api('get', '/v1/me', adminOf.token);
    const listed = (me.body.data.contexts as { societyId: string; isBlocked: boolean }[]).find(
      (context) => context.societyId === societyId,
    );
    console.log(
      'X3 list:',
      call.status,
      call.body.code,
      '| ME-01 isBlocked:',
      listed?.isBlocked,
      '| active:',
      JSON.stringify(loose(me).data.session.activeContext),
    );
    expect(call.status).toBe(423);
    expect
      .soft(listed?.isBlocked, 'every call is 423, so the chooser should say blocked')
      .toBe(true);
  });

  it('X4 an Admin with one blocked and one open Institution works in the open one and is not shown blocked', async () => {
    const societyId = await society();
    const blocked = await institution(societyId);
    const open = await institution(societyId);
    const adminOf = await fixtures.institutionAdmin(societyId, [blocked, open]);
    await block({ section: 'staff', societyId, institutionId: blocked, reason: 'Dues' });
    const list = await api('get', '/v1/institutions', adminOf.token);
    expect(list.status).toBe(200);
    expect(loose(list).data.map((row) => row.id)).toEqual([open]);
    const named = await api('get', `/v1/institutions/${blocked}`, adminOf.token);
    expect(named.status).toBe(423);
    expect(loose(named).code).toBe('SECTION_BLOCKED');
    expect((named.body as { data: unknown }).data).toEqual({ section: 'staff' });
    expect((await api('get', `/v1/institutions/${open}`, adminOf.token)).status).toBe(200);
    const me = await api('get', '/v1/me', adminOf.token);
    expect(loose(me).data.session.activeContext?.isBlocked).toBe(false);
  });

  it('X5 a blocked Owner keeps their profile and SOC-02, everything else is 423 with the section and without the reason', async () => {
    const societyId = await society();
    const inst = await institution(societyId);
    const owner = await ownerOf(societyId);
    await block({ section: 'owners', societyId, reason: 'Secret reason 42' });
    const results: string[] = [];
    for (const [method, path, body] of [
      ['get', '/v1/me', {}],
      ['get', '/v1/society/access-blocks', {}],
      ['get', '/v1/institutions', {}],
      ['get', `/v1/institutions/${inst}`, {}],
      ['post', '/v1/institutions', { name: 'X', code: 'XX1', address: { line1: '1' } }],
      ['patch', `/v1/institutions/${inst}`, { name: 'Renamed', version: 1 }],
      ['delete', `/v1/institutions/${inst}`, {}],
    ] as const) {
      const res = await api(method, path, owner.token, body);
      results.push(`${method.toUpperCase()} ${path.replace(/[0-9a-f-]{36}/, ':id')} ${res.status}`);
      if (res.status === 423) {
        expect(res.body.code).toBe('SECTION_BLOCKED');
        expect((res.body as { data: unknown }).data).toEqual({ section: 'owners' });
        expect(JSON.stringify(res.body)).not.toContain('Secret reason 42');
      }
    }
    console.log('X5', results.join(' | '));
    expect(results.map((line) => line.split(' ').at(-1))).toEqual([
      '200',
      '200',
      '423',
      '423',
      '423',
      '423',
      '423',
    ]);
  });

  it('X6 a lift and a new block of the same section at once never leave two active blocks', async () => {
    const societyId = await society();
    const outcomes: string[] = [];
    for (let round = 0; round < 8; round++) {
      const first = await block({ section: 'owners', societyId, reason: `Round ${round}` });
      expect(first.status).toBe(201);
      const [lift, again] = await Promise.all([
        api('delete', `${BLOCKS}/${first.body.data.id}`, admin),
        block({ section: 'owners', societyId, reason: `Again ${round}` }),
      ]);
      outcomes.push(`${lift.status}/${again.status}`);
      expect([500, 502, 503].includes(lift.status) || [500, 502, 503].includes(again.status)).toBe(
        false,
      );
      expect(await activeBlocks(societyId)).toBeLessThanOrEqual(1);
      await clearBlocks(ownerDb);
    }
    console.log('X6 lift/new:', outcomes.join(' '));
  });

  it('X7 a block and a Society deactivation at once both succeed; the block stays active on the deactivated Society (observation)', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 8; round++) {
      const societyId = await society();
      const [blocked, deactivated] = await Promise.all([
        block({ section: 'owners', societyId, reason: 'Dues' }),
        api('delete', `/v1/platform/societies/${societyId}`, admin),
      ]);
      outcomes.push(
        `${blocked.status}/${deactivated.status}/active=${await activeBlocks(societyId)}`,
      );
      expect([blocked.status, deactivated.status].some((status) => status >= 500)).toBe(false);
    }
    console.log('X7 block/deactivate:', outcomes.join(' '));
  });

  it('X8 the migration goes down with blocks in force and up again; a pause in force before it is dropped (observation)', async () => {
    const societyId = await society();
    await block({ section: 'owners', societyId, reason: 'Dues' });
    expect((await runMigrations(migrationUrl, 'down')).error).toBeUndefined();
    await ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.role_code', '1', true)`.execute(tx);
      await sql`update societies set access_paused_at = now(), access_paused_by = ${superAdmin.id},
        access_pause_reason = 'Paused before B10' where id = ${societyId}`.execute(tx);
    });
    expect((await runMigrations(migrationUrl, 'latest')).error).toBeUndefined();
    const after = await activeBlocks(societyId);
    console.log('X8 active blocks for the Society paused before the migration:', after);
    // Observation: nothing carries the pause over, so the Society works again after the migration.
    expect(after).toBe(0);
  });
});
