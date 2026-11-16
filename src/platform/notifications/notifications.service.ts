import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { ApiResult } from '../../common/http/api-result.js';
import { Clock } from '../../common/time/clock.js';
import { cursorMeta, decodeCursor } from '../../common/pagination/pagination.js';
import { DatabaseService, type TenantContext } from '../database/index.js';
import type { ListNotificationsQueryDto, PushDeviceDto } from './notifications.dto.js';
import { NotificationsRepository } from './notifications.repository.js';
import { notificationResource, type NotificationResource } from './notifications.resource.js';

/** The tab a list opens on: "Only for you" (DDD 9.8). */
const FIRST_TAB = 1;

/** What a person's inbox keeps for them alone: only their own rows are visible, by row-level security on the receiver. */
const asPerson = (principal: Principal): TenantContext => ({
  personId: principal.personId,
  roleCode: principal.roleCode,
});

/**
 * NTF-01 to NTF-05 and ME-04 (API design 9.1): a person's inbox, its bell, and the push token of their phone. The
 * inbox belongs to the person and not to a Society or a role, so it is the same in every context; the writing of it
 * is the worker's (`Notifications`).
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: NotificationsRepository,
    private readonly clock: Clock,
  ) {}

  /** NTF-01: one tab, newest first, a page at a time; a cursor used with other filters is 400 `CURSOR_INVALID`. */
  async list(
    principal: Principal,
    query: ListNotificationsQueryDto,
  ): Promise<ApiResult<NotificationResource[]>> {
    const filters = { tab: query.tab ?? FIRST_TAB, studentId: query.studentId ?? null };
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, filters);
    const rows = await this.database.transaction(asPerson(principal), (tx) =>
      this.repository.page(
        tx,
        { tab: filters.tab, studentId: query.studentId },
        after,
        query.limit,
      ),
    );
    const { items, meta } = cursorMeta(rows, query.limit, filters);
    return ApiResult.list(items.map(notificationResource), meta);
  }

  /** NTF-02: how many are unread, 10 at most (the app shows "9+"). */
  async unreadCount(principal: Principal): Promise<{ count: number }> {
    const count = await this.database.transaction(asPerson(principal), (tx) =>
      this.repository.unread(tx),
    );
    return { count };
  }

  /** NTF-03: marks one read; an item that is not the caller's is 404. Marking one already read changes nothing. */
  async markRead(principal: Principal, id: string): Promise<NotificationResource> {
    const row = await this.database.transaction(asPerson(principal), (tx) =>
      this.repository.markRead(tx, id, this.clock.now()),
    );
    if (!row) throw AppException.notFound();
    return notificationResource(row);
  }

  /** NTF-04: marks every unread item read, of one tab when it is named. */
  async markAllRead(principal: Principal, tab: number | undefined): Promise<{ updated: number }> {
    const updated = await this.database.transaction(asPerson(principal), (tx) =>
      this.repository.markAllRead(tx, tab, this.clock.now()),
    );
    return { updated };
  }

  /** NTF-05: deletes the caller's own items, of one tab when it is named. */
  async clear(principal: Principal, tab: number | undefined): Promise<{ deleted: number }> {
    const deleted = await this.database.transaction(asPerson(principal), (tx) =>
      this.repository.clear(tx, tab),
    );
    return { deleted };
  }

  /**
   * ME-04: registers or refreshes this session's push token. A mobile session only (403 otherwise). The token moves
   * to this session from any other that held it, and this session keeps only the token it sent last.
   */
  async registerDevice(principal: Principal, body: PushDeviceDto): Promise<void> {
    if (principal.clientType !== 'mobile') throw AppException.forbidden();
    await this.database.transaction(asPerson(principal), (tx) =>
      this.repository.registerDevice(tx, {
        userId: principal.personId,
        sessionId: principal.sessionId,
        fcmToken: body.fcmToken,
        platform: body.platform,
        appVersion: body.appVersion ?? null,
        language: body.language ?? 'en',
        now: this.clock.now(),
      }),
    );
  }
}
