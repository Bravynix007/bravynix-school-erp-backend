import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { newId } from '../../src/common/ids/ids.js';
import {
  createPool,
  DatabaseService,
  type Tx,
} from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import * as blocks from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit } from '../support/school-kit.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');

interface ItemBody {
  id: string;
  createdAt: string;
  category: number;
  tab: number;
  title: string;
  studentId: string | null;
  target: { type: number; id: string; date: string | null } | null;
  isRead: boolean;
}

/** NTF-01 to NTF-05 and ME-04 (API design 9.1): a person's own inbox and the push token of their phone. */
/** An ME-04 body for the token named `token`. */
const deviceBody = (token: string, fields: object = {}) => ({
  fcmToken: `test-token-${token}`,
  platform: 1,
  appVersion: '1.4.0',
  ...fields,
});

describe('the inbox and the push device', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;
  let societyId: string;
  let me: SignedInPerson;
  let other: SignedInPerson;

  /** A notice that names the day 21 November, with the target whose ID is [target] (none when null). */
  const insertWithDay = (target: string | null) =>
    ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.society_id', ${societyId}, true)`.execute(tx);
      await sql`
        insert into inbox_items (id, user_id, society_id, category, title, body, source_key, target_type,
          target_id, target_date)
        values (${newId()}, ${me.person}, ${societyId}, 1, 'Absent today', 'Diya is absent', ${`test:${newId()}`},
          ${target === null ? null : 2}, ${target}, '2026-11-21')`.execute(tx);
    });

  /** An inbox row, written as the worker does: under the Society, whoever receives it. */
  const put = async (
    user: string,
    fields: {
      day?: number;
      tab?: number;
      title?: string;
      studentId?: string | null;
      read?: boolean;
      target?: boolean;
      targetDate?: string;
    } = {},
  ) => {
    const id = newId();
    await ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.society_id', ${societyId}, true)`.execute(tx);
      await sql`
        insert into inbox_items (id, created_at, user_id, society_id, student_id, category, inbox_tab, title,
          body, source_key, target_type, target_id, target_date, read_at)
        values (${id}, ${`2026-11-${String(fields.day ?? 10).padStart(2, '0')}T10:00:00Z`}, ${user}, ${societyId},
          ${fields.studentId ?? null}, 1, ${fields.tab ?? 1}, ${fields.title ?? 'Absent today'}, 'Diya is absent',
          ${`test:${id}`}, ${fields.target ? 1 : null}, ${fields.target ? newId() : null},
          ${fields.target ? (fields.targetDate ?? null) : null},
          ${fields.read ? sql`now()` : null})
      `.execute(tx);
    });
    return id;
  };
  const list = (query = '', token = me.token) => api('get', `/v1/notifications${query}`, token);
  const items = async (query = '', token = me.token) => {
    const res = await list(query, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as ItemBody[];
  };
  const stored = async (user: string) =>
    (
      await ownerDb.transaction().execute(async (tx) => {
        await sql`alter table inbox_items no force row level security`.execute(tx);
        const rows = (
          await sql<{ id: string; read_at: Date | null; inbox_tab: number }>`
            select id, read_at, inbox_tab from inbox_items where user_id = ${user}`.execute(tx)
        ).rows;
        await sql`alter table inbox_items force row level security`.execute(tx);
        return rows;
      })
    ).toSorted((a, b) => a.id.localeCompare(b.id));
  const register = (payload: object, token = me.token) =>
    api('put', '/v1/me/push-device', token, payload);
  const devices = async () =>
    (
      await sql<{ fcm_token: string; user_id: string; session_id: string; app_language: string }>`
        select fcm_token, user_id, session_id, app_language from push_devices
        where fcm_token like 'test-token-%' order by fcm_token`.execute(ownerDb)
    ).rows;

  const asApp = <T>(
    work: (tx: Tx) => Promise<T>,
    personId = me.person,
    institutionIds?: string[],
  ) => database.transaction({ personId, societyId, institutionIds }, work);
  const month = async () =>
    (await sql<{ part: string }>`select to_char(now(), 'YYYY_MM') as part`.execute(ownerDb))
      .rows[0]!.part;

  const row = (society: string) =>
    sql`insert into inbox_items (user_id, society_id, category, title, body, source_key)
        values (${me.person}, ${society}, 1, 't', 'b', ${`own:${newId()}`})`;

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
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    societyId = await kit.society(admin);
    me = await fixtures.owner(societyId);
    other = await fixtures.owner(await kit.society(admin));
  });

  afterEach(async () => {
    await blocks.clearBlocks(ownerDb);
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('the day a notice is about', () => {
    it('is kept only with a target', async () => {
      await expect(insertWithDay(null)).rejects.toMatchObject({
        code: '23514',
        constraint: 'ck_inbox_items_target_date',
      });
      await expect(insertWithDay(newId())).resolves.not.toThrow();
    });
  });

  describe('NTF-01 list', () => {
    it('lists the caller’s own notices of the first tab, newest first, and never another person’s', async () => {
      const older = await put(me.person, { day: 3, title: 'Older' });
      const newer = await put(me.person, {
        day: 9,
        title: 'Newer',
        target: true,
        targetDate: '2026-11-21',
      });
      await put(me.person, { day: 5, tab: 2, title: 'In another tab' });
      await put(other.person, { day: 8, title: 'Not mine' });
      const rows = await items();
      expect(rows.map((r) => r.id)).toEqual([newer, older]);
      expect(rows[0]).toMatchObject({
        title: 'Newer',
        tab: 1,
        category: 1,
        isRead: false,
        target: { type: 1, id: expect.any(String), date: '2026-11-21' },
      });
      expect(rows[1]?.target).toBeNull();
      expect((await items('?tab=2')).map((r) => r.title)).toEqual(['In another tab']);
      expect(await items('?tab=3')).toEqual([]);
    });

    it('pages by cursor with no repeat and no gap, and refuses a cursor made for other filters', async () => {
      const ids: string[] = [];
      for (const day of [1, 2, 3, 4, 5]) ids.push(await put(me.person, { day }));
      const first = await list('?limit=2');
      expect(first.body.meta).toMatchObject({
        limit: 2,
        hasMore: true,
        nextCursor: expect.any(String),
      });
      const cursor = (first.body.meta as { nextCursor: string }).nextCursor;
      const second = await list(`?limit=2&cursor=${cursor}`);
      const third = await list(
        `?limit=2&cursor=${(second.body.meta as { nextCursor: string }).nextCursor}`,
      );
      const seen = [first, second, third].flatMap((res) =>
        (res.body.data as unknown as ItemBody[]).map((r) => r.id),
      );
      expect(seen).toEqual(ids.toReversed());
      expect(third.body.meta).toMatchObject({ hasMore: false, nextCursor: null });
      for (const wrong of [`?tab=2&limit=2&cursor=${cursor}`, '?cursor=garbage']) {
        const refused = await list(wrong);
        expect([refused.status, refused.body.code]).toEqual([400, 'CURSOR_INVALID']);
      }
    });

    it('keeps the notices of one child with studentId, and validates the query', async () => {
      const diya = newId();
      await put(me.person, { studentId: diya, title: 'About Diya' });
      await put(me.person, { studentId: newId(), title: 'About someone else' });
      expect((await items(`?studentId=${diya}`)).map((r) => r.title)).toEqual(['About Diya']);
      for (const bad of ['?tab=5', '?tab=x', '?limit=0', '?limit=101', '?studentId=nope']) {
        expect((await list(bad)).status).toBe(400);
      }
    });

    it('is open to every mobile role, still answers while the caller’s section is blocked, and is not for a Super Admin', async () => {
      await put(me.person);
      await blocks.setBlock(ownerDb, societyId, null, 1, true);
      expect((await items()).length).toBe(1);
      expect((await list('', admin)).status).toBe(403);
      expect((await request(t.app.getHttpServer()).get('/v1/notifications')).status).toBe(401);
    });
  });

  describe('NTF-02 unread count', () => {
    it('counts the unread, 10 at most, and not the read ones or another person’s', async () => {
      for (let day = 1; day <= 12; day += 1) await put(me.person, { day: Math.min(day, 28) });
      await put(me.person, { read: true });
      await put(other.person);
      const res = await api('get', '/v1/notifications/unread-count', me.token);
      expect(res.body.data).toEqual({ count: 10 });
      const few = await api('get', '/v1/notifications/unread-count', other.token);
      expect(few.body.data).toEqual({ count: 1 });
    });
  });

  describe('NTF-03 mark one read', () => {
    it('marks the caller’s own notice read, and a second time changes nothing', async () => {
      const id = await put(me.person);
      const first = await api('post', `/v1/notifications/${id}/read`, me.token);
      expect(first.status).toBe(200);
      expect(first.body.data).toMatchObject({ id, isRead: true, readAt: expect.any(String) });
      // Later by the clock, so a second call that wrote the time again would show.
      t.clock.advanceMinutes(5);
      const again = await api('post', `/v1/notifications/${id}/read`, me.token);
      expect(again.body.data).toMatchObject({ readAt: first.body.data.readAt });
      expect(await api('get', '/v1/notifications/unread-count', me.token)).toMatchObject({
        body: { data: { count: 0 } },
      });
    });

    it('is 404 for another person’s notice, which stays unread, and for an ID that is nothing', async () => {
      const theirs = await put(other.person);
      expect((await api('post', `/v1/notifications/${theirs}/read`, me.token)).status).toBe(404);
      expect((await stored(other.person))[0]?.read_at).toBeNull();
      expect((await api('post', `/v1/notifications/${newId()}/read`, me.token)).status).toBe(404);
      expect((await api('post', '/v1/notifications/not-a-uuid/read', me.token)).status).toBe(404);
    });
  });

  describe('NTF-04 mark all read', () => {
    it('marks every unread notice of the caller read, of one tab when it is named, and no one else’s', async () => {
      await put(me.person, { tab: 1 });
      await put(me.person, { tab: 2 });
      await put(me.person, { tab: 2, read: true });
      await put(other.person, { tab: 2 });
      const one = await api('post', '/v1/notifications/read-all?tab=2', me.token);
      expect(one.body.data).toEqual({ updated: 1 });
      expect((await stored(me.person)).filter((r) => r.read_at === null)).toHaveLength(1);
      const all = await api('post', '/v1/notifications/read-all', me.token);
      expect(all.body.data).toEqual({ updated: 1 });
      expect((await stored(other.person))[0]?.read_at).toBeNull();
      expect((await api('post', '/v1/notifications/read-all?tab=9', me.token)).status).toBe(400);
    });
  });

  describe('NTF-05 clear', () => {
    it('deletes the caller’s own notices, of one tab when it is named, and no one else’s', async () => {
      await put(me.person, { tab: 1 });
      await put(me.person, { tab: 2 });
      await put(other.person, { tab: 1 });
      const one = await api('delete', '/v1/notifications?tab=2', me.token);
      expect(one.body.data).toEqual({ deleted: 1 });
      expect(await stored(me.person)).toHaveLength(1);
      const all = await api('delete', '/v1/notifications', me.token);
      expect(all.body.data).toEqual({ deleted: 1 });
      expect(await stored(me.person)).toHaveLength(0);
      expect(await stored(other.person)).toHaveLength(1);
    });
  });

  describe('row-level security, as the app role', () => {
    it('refuses a partition addressed by name, for every kind of access, so the policies of the table cannot be walked around', async () => {
      await put(other.person);
      const part = `inbox_items_${await month()}`;
      const statements = [
        sql`select count(*) from ${sql.table(part)}`,
        sql`insert into ${sql.table(part)} (user_id, society_id, category, title, body, source_key)
          values (${me.person}, ${societyId}, 1, 't', 'b', 'x:1')`,
        sql`update ${sql.table(part)} set read_at = now()`,
        sql`delete from ${sql.table(part)}`,
      ];
      for (const statement of statements) {
        await expect(asApp((tx) => statement.execute(tx))).rejects.toMatchObject({ code: '42501' });
      }
      // The table itself still answers, with the caller's own rows only.
      expect(
        await asApp(async (tx) => (await sql`select 1 from inbox_items`.execute(tx)).rows.length),
      ).toBe(0);
    });

    it('lets a notice be written for the caller’s Society only', async () => {
      await expect(asApp((tx) => row(societyId).execute(tx))).resolves.toBeDefined();
      const elsewhere = await kit.society(admin);
      await expect(asApp((tx) => row(elsewhere).execute(tx))).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  describe('ME-04 push device', () => {
    it('registers this session’s token, refreshes it, and keeps only the token the session sent last', async () => {
      expect((await register(deviceBody('a'))).status).toBe(200);
      expect(await devices()).toEqual([
        expect.objectContaining({
          fcm_token: 'test-token-a',
          user_id: me.person,
          app_language: 'en',
        }),
      ]);
      expect((await register(deviceBody('a', { language: 'kn' }))).status).toBe(200);
      expect((await devices())[0]?.app_language).toBe('kn');
      expect((await register(deviceBody('b'))).status).toBe(200);
      expect((await devices()).map((d) => d.fcm_token)).toEqual(['test-token-b']);
    });

    it('moves a token to the session that sends it now, whoever held it', async () => {
      await register(deviceBody('a'));
      const secondLogin = await signInMobile(t, other.email);
      expect((await register(deviceBody('a'), secondLogin.accessToken)).status).toBe(200);
      expect(await devices()).toEqual([
        expect.objectContaining({
          fcm_token: 'test-token-a',
          user_id: other.person,
          session_id: secondLogin.session.id,
        }),
      ]);
    });

    it('is removed with its session', async () => {
      await register(deviceBody('a'));
      expect(await devices()).toHaveLength(1);
      await clearLoginState(ownerDb);
      expect(await devices()).toHaveLength(0);
    });

    it('is removed when its session ends by AUTH-07 logout, and only that session’s', async () => {
      await register(deviceBody('a'));
      const secondLogin = await signInMobile(t, other.email);
      await register(deviceBody('b'), secondLogin.accessToken);
      expect((await api('post', '/v1/auth/logout', me.token, {})).status).toBe(200);
      expect((await devices()).map((d) => d.fcm_token)).toEqual(['test-token-b']);
    });

    it('is removed when every session ends by AUTH-08 logout of all', async () => {
      const secondLogin = await signInMobile(t, other.email);
      await register(deviceBody('b'), secondLogin.accessToken);
      expect((await api('post', '/v1/auth/logout-all', secondLogin.accessToken, {})).status).toBe(
        200,
      );
      expect(await devices()).toEqual([]);
    });

    it('is removed whatever ends the session, and stays while the session lives', async () => {
      await register(deviceBody('a'));
      const [device] = await devices();
      expect(device).toBeDefined();
      await sql`update auth_sessions set ended_at = now(), end_reason = 4 where id = ${device!.session_id}`.execute(
        ownerDb,
      );
      expect(await devices()).toEqual([]);
    });

    it('checks the body, and is for a phone: a console session is 403', async () => {
      for (const bad of [
        {},
        deviceBody('a', { fcmToken: '' }),
        deviceBody('a', { fcmToken: 'x'.repeat(513) }),
        deviceBody('a', { platform: 3 }),
        deviceBody('a', { appVersion: 'v'.repeat(21) }),
        deviceBody('a', { language: 'e' }),
      ]) {
        expect((await register(bad)).status).toBe(400);
      }
      expect((await register(deviceBody('a'), admin)).status).toBe(403);
      expect(await devices()).toEqual([]);
    });
  });
});
