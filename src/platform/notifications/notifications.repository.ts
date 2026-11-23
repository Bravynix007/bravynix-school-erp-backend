import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import {
  beforeCursor,
  cursorTimestamp,
  type CursorAt,
  type CursorPosition,
} from '../../common/pagination/pagination.js';
import type { Tx } from '../database/index.js';
import type { InboxItemsTable, PushDevicesTable } from './notifications.tables.js';
import type { NoticeTarget } from './notifications.rules.js';

/** The unread count stops here: the bell shows "9+" (DDD 9.8). */
const UNREAD_CAP = 10;

/** One inbox row as a page reads it, with its position for the next cursor. */
export type InboxRow = Pick<
  Selectable<InboxItemsTable>,
  | 'id'
  | 'created_at'
  | 'society_id'
  | 'institution_id'
  | 'student_id'
  | 'category'
  | 'inbox_tab'
  | 'title'
  | 'body'
  | 'sender_display_name'
  | 'target_type'
  | 'target_id'
  | 'target_date'
  | 'read_at'
> & { cursorAt: CursorAt };

/** A notice to be written to some receivers. */
export interface DeliveredNotice {
  societyId: string;
  institutionId: string | null;
  sourceKey: string;
  occurredAt: string;
  category: number;
  tab: number;
  title: string;
  body: string;
  senderDisplayName: string | null;
  target: NoticeTarget | null;
  receivers: { userId: string; studentId: string | null }[];
}

/** A phone a push can go to. */
export type PushDeviceRow = Pick<
  Selectable<PushDevicesTable>,
  'fcm_token' | 'platform' | 'app_language'
>;

export interface NewPushDevice {
  userId: string;
  sessionId: string;
  fcmToken: string;
  platform: number;
  appVersion: string | null;
  language: string;
  now: Date;
}

/**
 * The tables of the Notifications module: `inbox_items`, read through row-level security on the receiver, and
 * `push_devices`, which carries no tenant and is touched here only (SDD 9.3 rule 1).
 */
@Injectable()
export class NotificationsRepository {
  private rows(tx: Tx) {
    return tx
      .selectFrom('inbox_items')
      .select([
        'id',
        'created_at',
        'society_id',
        'institution_id',
        'student_id',
        'category',
        'inbox_tab',
        'title',
        'body',
        'sender_display_name',
        'target_type',
        'target_id',
        'target_date',
        'read_at',
        cursorTimestamp('created_at').as('cursorAt'),
      ]);
  }

  /** A page of the caller's items, newest first, one more than `limit` so the page knows whether there is a next. */
  page(
    tx: Tx,
    filter: { tab: number; studentId: string | undefined },
    after: CursorPosition | undefined,
    limit: number,
  ): Promise<InboxRow[]> {
    let query = this.rows(tx).where('inbox_tab', '=', filter.tab);
    if (filter.studentId !== undefined) query = query.where('student_id', '=', filter.studentId);
    if (after) query = query.where(beforeCursor(after));
    return query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
  }

  /** How many unread items the caller has, up to the cap. */
  async unread(tx: Tx): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from (
        select 1 from inbox_items where read_at is null limit ${UNREAD_CAP}
      ) capped
    `.execute(tx);
    return rows[0]?.n ?? 0;
  }

  /** Marks one item read; none is found for an item that is not the caller's. An item already read keeps its time. */
  async markRead(tx: Tx, id: string, now: Date): Promise<InboxRow | undefined> {
    const updated = await tx
      .updateTable('inbox_items')
      .set({ read_at: sql`coalesce(read_at, ${now}::timestamptz)` })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (!updated) return undefined;
    return this.rows(tx).where('id', '=', id).executeTakeFirst();
  }

  /** Marks the caller's unread items read, of one tab or of all; returns how many changed. */
  async markAllRead(tx: Tx, tab: number | undefined, now: Date): Promise<number> {
    const result = await tx
      .updateTable('inbox_items')
      .set({ read_at: now })
      .where('read_at', 'is', null)
      .$if(tab !== undefined, (query) => query.where('inbox_tab', '=', tab!))
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Deletes the caller's items, of one tab or of all; returns how many went. */
  async clear(tx: Tx, tab: number | undefined): Promise<number> {
    const result = await tx
      .deleteFrom('inbox_items')
      .$if(tab !== undefined, (query) => query.where('inbox_tab', '=', tab!))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Registers this session's token. The token is unique: another session of the same phone (a reinstall) or of another
   * person (a phone handed on) loses it to this one, and this session keeps only the token it sends last.
   */
  async registerDevice(tx: Tx, device: NewPushDevice): Promise<void> {
    await tx
      .deleteFrom('push_devices')
      .where('session_id', '=', device.sessionId)
      .where('fcm_token', '<>', device.fcmToken)
      .execute();
    await tx
      .insertInto('push_devices')
      .values({
        user_id: device.userId,
        session_id: device.sessionId,
        fcm_token: device.fcmToken,
        platform: device.platform,
        app_version: device.appVersion,
        app_language: device.language,
        last_seen_at: device.now,
      })
      .onConflict((conflict) =>
        conflict.column('fcm_token').doUpdateSet({
          user_id: device.userId,
          session_id: device.sessionId,
          platform: device.platform,
          app_version: device.appVersion,
          app_language: device.language,
          last_seen_at: device.now,
        }),
      )
      .execute();
  }

  /**
   * Writes a notice to receivers (`maintenance.deliver_inbox_items`, which refuses another Society than the job's) and
   * answers the people whose row it added; a person who already had it, from an earlier run, is left out.
   */
  async deliver(tx: Tx, notice: DeliveredNotice): Promise<string[]> {
    const { rows } = await sql<{ receiver_id: string }>`
      select receiver_id from maintenance.deliver_inbox_items(
        ${notice.societyId}::uuid, ${notice.institutionId}::uuid, ${notice.sourceKey}, ${notice.occurredAt}::timestamptz,
        ${notice.category}::smallint, ${notice.tab}::smallint, ${notice.title}, ${notice.body},
        ${notice.senderDisplayName}, ${notice.target?.type ?? null}::smallint, ${notice.target?.id ?? null}::uuid, ${notice.target?.date ?? null}::date,
        ${JSON.stringify(notice.receivers)}::jsonb
      )
    `.execute(tx);
    return rows.map((row) => row.receiver_id);
  }

  /** The phones of these people. */
  devicesOf(tx: Tx, userIds: string[]): Promise<PushDeviceRow[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return tx
      .selectFrom('push_devices')
      .select(['fcm_token', 'platform', 'app_language'])
      .where('user_id', 'in', userIds)
      .orderBy('id')
      .execute();
  }

  /** Removes the tokens a provider said are no longer valid. */
  async removeDevices(tx: Tx, tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await tx.deleteFrom('push_devices').where('fcm_token', 'in', tokens).execute();
  }
}
