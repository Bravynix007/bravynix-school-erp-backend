import { Kysely, PostgresDialect, sql } from 'kysely';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { newId } from '../../src/common/ids/ids.js';
import { JobRunner } from '../../src/platform/jobs/index.js';
import {
  Notifications,
  PushSender,
  type Notice,
  type PushMessage,
} from '../../src/platform/notifications/index.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { FixtureModule } from '../support/fixture.module.js';
import { asOwnerOf } from '../support/owner-rows.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit } from '../support/school-kit.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');

interface ItemBody {
  id: string;
  createdAt: string;
  title: string;
  body: string;
  category: number;
  studentId: string | null;
  senderDisplayName: string | null;
  target: { type: number; id: string } | null;
  isRead: boolean;
}

/** The worker writes a notice to its receivers' inboxes and sends the push (SDD 9.3 rule 4, 11.2; DDD 9.8). */
const message = (token: string, language: string) => ({
  token,
  platform: 1,
  language,
  title: 'Diya is absent today',
  body: 'Marked absent in the morning',
});

describe('a notice reaches its receivers', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let notifications: Notifications;
  let runner: JobRunner;
  let sender: PushSender;
  let admin: string;
  let societyId: string;
  let institutionId: string;
  let first: SignedInPerson;
  let second: SignedInPerson;
  let outsider: SignedInPerson;
  let sent: PushMessage[][];

  const occurredAt = new Date(Date.now() - 3_600_000);

  const notice = (fields: Partial<Notice> = {}): Notice => ({
    societyId,
    institutionId: null,
    sourceKey: `test:${newId()}`,
    occurredAt,
    category: 1,
    tab: 1,
    title: 'Diya is absent today',
    body: 'Marked absent in the morning',
    senderDisplayName: 'Ms Rao',
    target: { type: 1, id: newId() },
    receivers: [{ userId: first.person }, { userId: second.person }],
    ...fields,
  });
  /** Asks for the notice as a module does, in its own transaction, then lets the worker drain the queue. */
  const send = async (value: Notice) => {
    const job = await database.transaction({ societyId, institutionIds: [institutionId] }, (tx) =>
      notifications.notify(tx, value, first.person),
    );
    while (await runner.runNext()) {
      // the worker drains the queue
    }
    return job;
  };
  /** Asks for the notice in a transaction of the Society, as a module does. */
  const queue = (value: Notice) =>
    database.transaction({ societyId, institutionIds: [institutionId] }, (tx) =>
      notifications.notify(tx, value, null),
    );
  const inbox = async (who: SignedInPerson) => {
    const res = await api('get', '/v1/notifications', who.token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as ItemBody[];
  };
  const register = async (who: SignedInPerson, token: string, language = 'en') =>
    expect(
      (
        await api('put', '/v1/me/push-device', who.token, {
          fcmToken: token,
          platform: 1,
          language,
        })
      ).status,
    ).toBe(200);
  /** The rows as their receiver reads them, with the Society and Institution they were written for. */
  const stored = (who: SignedInPerson) =>
    database.transaction(
      { personId: who.person, societyId, institutionIds: [institutionId] },
      async (tx) =>
        (
          await sql<{
            society_id: string;
            institution_id: string | null;
          }>`select society_id, institution_id from inbox_items`.execute(tx)
        ).rows,
    );
  const tokens = async () =>
    (
      await sql<{ fcm_token: string }>`
        select fcm_token from push_devices where fcm_token like 'fanout-%' order by 1`.execute(
        ownerDb,
      )
    ).rows.map((r) => r.fcm_token);

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
    notifications = t.app.get(Notifications, { strict: false });
    runner = t.app.get(JobRunner);
    sender = t.app.get(PushSender, { strict: false });
    fixtures = new PlatformFixtures(t, ownerDb);
    api = apiCaller(t);
    kit = new SchoolKit(t, api);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    sent = [];
    vi.spyOn(sender, 'send').mockImplementation((messages) => {
      sent.push(messages);
      return Promise.resolve(messages.map(() => 'sent' as const));
    });
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    societyId = await kit.society(admin);
    first = await fixtures.owner(societyId);
    const categoryId = (await kit.masters(admin, 'class-categories'))[0]!.id;
    institutionId = await kit.institution(first.token, categoryId);
    second = await fixtures.institutionAdmin(societyId, [institutionId]);
    outsider = await fixtures.owner(await kit.society(admin));
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  it('writes one row for each receiver, at the time of the source event, and nobody else sees it', async () => {
    const value = notice({
      institutionId,
      receivers: [{ userId: first.person, studentId: null }, { userId: second.person }],
    });
    await send(value);
    expect(await stored(first)).toEqual([{ society_id: societyId, institution_id: institutionId }]);
    expect(await stored(second)).toEqual([
      { society_id: societyId, institution_id: institutionId },
    ]);
    const [mine] = await inbox(first);
    expect(mine).toMatchObject({
      title: 'Diya is absent today',
      body: 'Marked absent in the morning',
      category: 1,
      senderDisplayName: 'Ms Rao',
      target: value.target,
      isRead: false,
      createdAt: occurredAt.toISOString(),
    });
    expect(await inbox(second)).toHaveLength(1);
    expect(await inbox(outsider)).toEqual([]);
  });

  it('adds nothing and pushes nothing when the same notice runs again', async () => {
    await register(first, 'fanout-1');
    const value = notice({ receivers: [{ userId: first.person }] });
    await send(value);
    await send(value);
    expect(await inbox(first)).toHaveLength(1);
    expect(sent.flat()).toHaveLength(1);
  });

  it('adds only the receivers that are new when a notice is asked for again with more people', async () => {
    const value = notice({ receivers: [{ userId: first.person }] });
    await send(value);
    await register(first, 'fanout-1');
    await register(second, 'fanout-2');
    await send({ ...value, receivers: [{ userId: first.person }, { userId: second.person }] });
    expect(await inbox(first)).toHaveLength(1);
    expect(await inbox(second)).toHaveLength(1);
    expect(sent.flat().map((m) => m.token)).toEqual(['fanout-2']);
  });

  it('sends the title and body only, to the phones of the receivers, each in its own language', async () => {
    await register(first, 'fanout-1');
    await register(second, 'fanout-2', 'kn');
    await register(outsider, 'fanout-3');
    await send(notice());
    expect(sent.flat().toSorted((a, b) => a.token.localeCompare(b.token))).toEqual([
      message('fanout-1', 'en'),
      message('fanout-2', 'kn'),
    ]);
  });

  it('removes a token the provider says is invalid, and keeps the others', async () => {
    await register(first, 'fanout-1');
    await register(second, 'fanout-2');
    vi.spyOn(sender, 'send').mockImplementation((messages) =>
      Promise.resolve(messages.map((m) => (m.token === 'fanout-1' ? 'invalid_token' : 'sent'))),
    );
    await send(notice());
    expect(await tokens()).toEqual(['fanout-2']);
  });

  it('keeps the notice when the push cannot be sent, and does not fail the job', async () => {
    await register(first, 'fanout-1');
    vi.spyOn(sender, 'send').mockRejectedValue(new Error('provider is down'));
    const job = await send(notice({ receivers: [{ userId: first.person }] }));
    expect(await inbox(first)).toHaveLength(1);
    const { rows } = await sql<{
      job_status: number;
    }>`select job_status from jobs where id = ${job}`.execute(ownerDb);
    expect(rows[0]!.job_status).toBe(3);
    expect(await tokens()).toEqual(['fanout-1']);
  });

  it('is queued in the caller’s transaction, so a change that is undone sends nothing', async () => {
    await expect(
      database.transaction({ societyId, institutionIds: [institutionId] }, async (tx) => {
        await notifications.notify(tx, notice(), first.person);
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    while (await runner.runNext()) {
      // the worker drains the queue
    }
    expect(await inbox(first)).toEqual([]);
  });

  it('queues nothing for a notice without receivers, and refuses one that is not well formed', async () => {
    await expect(queue(notice({ receivers: [] }))).resolves.toBeNull();
    await expect(queue(notice({ title: ' ' }))).rejects.toThrow(/title/);
    await expect(queue(notice({ category: 11 }))).rejects.toThrow(/category/);
  });

  it('refuses a write for another Society than the job’s', async () => {
    const other = await kit.society(admin);
    await expect(
      database.transaction({ societyId, institutionIds: [institutionId] }, (tx) =>
        sql`select * from maintenance.deliver_inbox_items(
          ${other}::uuid, null, 'x:1', now(), 1::smallint, 1::smallint, 't', 'b', null, null, null,
          ${JSON.stringify([{ userId: first.person, studentId: null }])}::jsonb)`.execute(tx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a write that names no Society, even when the job has none', async () => {
    await expect(
      database.transaction({ institutionIds: [] }, (tx) =>
        sql`select * from maintenance.deliver_inbox_items(
          null, null, 'x:1', now(), 1::smallint, 1::smallint, 't', 'b', null, null, null,
          ${JSON.stringify([{ userId: first.person, studentId: null }])}::jsonb)`.execute(tx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('passes over a receiver who is no person, and still delivers to the rest of the batch', async () => {
    await send(
      notice({
        receivers: [{ userId: newId() }, { userId: first.person }, { userId: second.person }],
      }),
    );
    expect(await inbox(first)).toHaveLength(1);
    expect(await inbox(second)).toHaveLength(1);
  });

  it('sends no push to a phone whose session has ended', async () => {
    await register(first, 'fanout-logged-out');
    await register(second, 'fanout-live');
    expect((await api('post', '/v1/auth/logout', first.token, {})).status).toBe(200);
    await send(notice());
    expect(sent.flat().map((m) => m.token)).toEqual(['fanout-live']);
  });

  it('writes a large audience in batches, one row for each person', async () => {
    const { rows } = await sql<{ id: string }>`
      insert into users (id, email)
      select gen_random_uuid(), 'fanout-' || n || '@fanout.test' from generate_series(1, 450) as n
      returning id`.execute(ownerDb);
    try {
      const source = `test:${newId()}`;
      await send(notice({ sourceKey: source, receivers: rows.map((r) => ({ userId: r.id })) }));
      let written = 0;
      await asOwnerOf(ownerDb, ['inbox_items'], async (tx) => {
        written = (
          await sql<{ n: number }>`
            select count(*)::int as n from inbox_items where source_key = ${source}`.execute(tx)
        ).rows[0]!.n;
      });
      expect(written).toBe(450);
    } finally {
      await sql`delete from users where email like '%@fanout.test'`.execute(ownerDb);
    }
  });
});
