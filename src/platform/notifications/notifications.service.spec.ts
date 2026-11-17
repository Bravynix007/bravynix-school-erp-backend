import type { Principal } from '../../common/auth/access-token-verifier.js';
import { FixedClock } from '../../common/time/clock.js';
import type { DatabaseService, Tx } from '../database/index.js';
import type { ListNotificationsQueryDto, PushDeviceDto } from './notifications.dto.js';
import { NotificationsRepository, type InboxRow } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

const IDS = {
  a: '0198f0a0-0000-7000-8000-00000000000a',
  b: '0198f0a0-0000-7000-8000-00000000000b',
  c: '0198f0a0-0000-7000-8000-00000000000c',
};
const NOW = '2026-11-16T10:00:00.000Z';

const principal = (fields: Partial<Principal> = {}): Principal => ({
  personId: 'person-1',
  sessionId: 'session-1',
  roleCode: 5,
  societyId: null,
  clientType: 'mobile',
  viaSupportAccess: false,
  ...fields,
});

const row = (id: string, fields: Partial<InboxRow> = {}): InboxRow => ({
  id,
  created_at: new Date('2026-11-16T09:00:00.000Z'),
  society_id: 'soc-1',
  institution_id: 'ins-1',
  student_id: null,
  category: 1,
  inbox_tab: 1,
  title: 'Holiday',
  body: 'School is closed',
  sender_display_name: null,
  target_type: null,
  target_id: null,
  read_at: null,
  cursorAt: '2026-11-16T09:00:00.000000Z' as InboxRow['cursorAt'],
  ...fields,
});

const query = (fields: Partial<ListNotificationsQueryDto> = {}): ListNotificationsQueryDto =>
  Object.assign({ limit: 2 }, fields) as ListNotificationsQueryDto;

const setup = () => {
  const repository = {
    page: vi.fn<NotificationsRepository['page']>().mockResolvedValue([]),
    unread: vi.fn<NotificationsRepository['unread']>().mockResolvedValue(0),
    markRead: vi.fn<NotificationsRepository['markRead']>().mockResolvedValue(undefined),
    markAllRead: vi.fn<NotificationsRepository['markAllRead']>().mockResolvedValue(0),
    clear: vi.fn<NotificationsRepository['clear']>().mockResolvedValue(0),
    registerDevice: vi.fn<NotificationsRepository['registerDevice']>().mockResolvedValue(),
  };
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work({} as Tx));
  const service = new NotificationsService(
    { transaction } as unknown as DatabaseService,
    repository as unknown as NotificationsRepository,
    new FixedClock(NOW),
  );
  return { service, repository, transaction };
};

describe('NotificationsService', () => {
  it('reads and writes as the person alone, with no Society or Institution', async () => {
    const { service, transaction } = setup();
    await service.unreadCount(principal({ roleCode: 4, societyId: 'soc-1' }));
    expect(transaction).toHaveBeenCalledWith(
      { personId: 'person-1', roleCode: 4 },
      expect.any(Function),
    );
  });

  describe('list', () => {
    it('opens on the first tab and reports no further page when the rows fit', async () => {
      const { service, repository } = setup();
      repository.page.mockResolvedValue([row(IDS.a)]);
      const result = await service.list(principal(), query());
      expect(repository.page).toHaveBeenCalledWith(
        expect.anything(),
        { tab: 1, studentId: undefined },
        undefined,
        2,
      );
      expect(result.options.meta).toMatchObject({ hasMore: false, nextCursor: null });
    });

    it('hands back a cursor when one more row exists, and takes it again only with the same filters', async () => {
      const { service, repository } = setup();
      repository.page.mockResolvedValue([row(IDS.a), row(IDS.b), row(IDS.c)]);
      const first = await service.list(principal(), query({ tab: 2 }));
      const nextCursor = (first.options.meta as { nextCursor: string }).nextCursor;
      expect(nextCursor).toEqual(expect.any(String));

      repository.page.mockResolvedValue([]);
      await service.list(principal(), query({ tab: 2, cursor: nextCursor }));
      expect(repository.page.mock.calls[1]?.[2]).toMatchObject({ id: IDS.b });

      await expect(
        service.list(principal(), query({ tab: 3, cursor: nextCursor })),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  it('NTF-02 returns the count the repository gives', async () => {
    const { service, repository } = setup();
    repository.unread.mockResolvedValue(10);
    await expect(service.unreadCount(principal())).resolves.toEqual({ count: 10 });
  });

  describe('markRead', () => {
    it('is 404 for an item that is not the caller’s', async () => {
      const { service } = setup();
      await expect(service.markRead(principal(), 'x')).rejects.toMatchObject({ status: 404 });
    });

    it('returns the item, read at the time of the request', async () => {
      const { service, repository } = setup();
      repository.markRead.mockResolvedValue(row('a', { read_at: new Date(NOW) }));
      const result = await service.markRead(principal(), 'a');
      expect(repository.markRead).toHaveBeenCalledWith(expect.anything(), 'a', new Date(NOW));
      expect(result).toMatchObject({ id: 'a', isRead: true, readAt: NOW });
    });
  });

  it('NTF-04 and NTF-05 name the counts and pass the tab on', async () => {
    const { service, repository } = setup();
    repository.markAllRead.mockResolvedValue(3);
    repository.clear.mockResolvedValue(4);
    await expect(service.markAllRead(principal(), 2)).resolves.toEqual({ updated: 3 });
    await expect(service.clear(principal(), undefined)).resolves.toEqual({ deleted: 4 });
    expect(repository.markAllRead).toHaveBeenCalledWith(expect.anything(), 2, new Date(NOW));
    expect(repository.clear).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  describe('registerDevice', () => {
    const body = { fcmToken: 'tok', platform: 1 } as PushDeviceDto;

    it('is 403 for a web session and stores nothing', async () => {
      const { service, repository, transaction } = setup();
      await expect(
        service.registerDevice(principal({ clientType: 'console' }), body),
      ).rejects.toMatchObject({ status: 403 });
      expect(transaction).not.toHaveBeenCalled();
      expect(repository.registerDevice).not.toHaveBeenCalled();
    });

    it('stores the token for this session, with English and no version by default', async () => {
      const { service, repository } = setup();
      await service.registerDevice(principal(), body);
      expect(repository.registerDevice).toHaveBeenCalledWith(expect.anything(), {
        userId: 'person-1',
        sessionId: 'session-1',
        fcmToken: 'tok',
        platform: 1,
        appVersion: null,
        language: 'en',
        now: new Date(NOW),
      });
    });
  });
});
