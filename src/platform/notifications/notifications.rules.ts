import { isUuid } from '../../common/ids/ids.js';
import { isCalendarDate } from '../../common/validation/calendar-date.js';
import { INBOX_TABS, type InboxTab } from './notifications.dto.js';

/** The kind of job that writes a notice to its receivers' inboxes and sends the push. */
export const NOTIFY_JOB = 'notify';

/** Receivers written in one transaction: the most a restarted job redoes, and the lease is renewed between batches. */
export const FANOUT_BATCH = 200;

/** The most receivers one notice may name; a larger audience is sent as several notices. */
export const MAX_RECEIVERS = 5000;

/** Longest `sourceKey` (`inbox_items.source_key`). */
export const MAX_SOURCE_KEY = 100;
export const MAX_TITLE = 150;
export const MAX_BODY = 1000;
const MAX_SENDER = 200;

/** One person who is to get the notice, and the child it is about when it is about one. */
export interface Receiver {
  userId: string;
  studentId?: string | null;
}

/** The screen a notice opens: 1 Attendance, 2 Diary, 3 Event, 4 Exam, 5 Result, and so on (DDD 9.8). */
export interface NoticeTarget {
  type: number;
  id: string;
  /** The day it is about (`YYYY-MM-DD`), for a screen that opens on a day: a diary entry's date. */
  date?: string | null;
}

/**
 * A notice a module asks for in its own transaction (SDD 9.3 rule 4). The text is what the inbox shows and the push
 * carries: nothing more than the screen does, and never marks, amounts or IDs (SDD 18).
 */
export interface Notice {
  societyId: string;
  institutionId: string | null;
  /**
   * What produced the notice, such as `absent:<session>:<enrolment>`. With the receiver and `occurredAt` it is unique,
   * so a job that runs twice adds nothing twice.
   */
  sourceKey: string;
  /** When the source event happened, kept as the notice's time: the same on every run of the job. */
  occurredAt: Date;
  /** 0 Account, 1 Attendance, 2 Diary, 3 Events and holidays, ... 10 Platform dues (DDD 9.8). */
  category: number;
  tab: InboxTab;
  title: string;
  body: string;
  senderDisplayName?: string | null;
  target?: NoticeTarget | null;
  receivers: Receiver[];
}

/** A notice as the job record keeps it. */
export interface NoticePayload {
  sourceKey: string;
  occurredAt: string;
  category: number;
  tab: InboxTab;
  title: string;
  body: string;
  senderDisplayName: string | null;
  target: NoticeTarget | null;
  receivers: { userId: string; studentId: string | null }[];
}

function fail(what: string): never {
  throw new Error(`A notice ${what}`);
}

/** A notice that is not well formed is the asking module's bug, so it is refused where it is asked for. */
export function checkNotice(notice: Notice): void {
  if (notice.sourceKey.length === 0 || notice.sourceKey.length > MAX_SOURCE_KEY) {
    fail(`needs a source key of 1 to ${MAX_SOURCE_KEY.toString()} characters`);
  }
  if (!Number.isInteger(notice.category) || notice.category < 0 || notice.category > 10) {
    fail('needs a category from 0 to 10');
  }
  if (!INBOX_TABS.includes(notice.tab)) fail('needs a tab from 1 to 4');
  if (notice.title.trim() === '' || notice.title.length > MAX_TITLE) {
    fail(`needs a title of 1 to ${MAX_TITLE.toString()} characters`);
  }
  if (notice.body.length > MAX_BODY)
    fail(`needs a body of at most ${MAX_BODY.toString()} characters`);
  if ((notice.senderDisplayName?.length ?? 0) > MAX_SENDER)
    fail('has a sender name that is too long');
  if (notice.institutionId !== null && !isUuid(notice.institutionId))
    fail('names an Institution that is not an ID');
  if (
    notice.target &&
    (!Number.isInteger(notice.target.type) ||
      notice.target.type < 1 ||
      notice.target.type > 12 ||
      !isUuid(notice.target.id))
  ) {
    fail('names a screen that does not exist');
  }
  if (notice.target?.date != null && !isCalendarDate(notice.target.date)) {
    fail('names a day that is not a date');
  }
  if (notice.receivers.length > MAX_RECEIVERS) {
    fail(`names more than ${MAX_RECEIVERS.toString()} receivers`);
  }
  for (const receiver of notice.receivers) {
    if (!isUuid(receiver.userId) || (receiver.studentId != null && !isUuid(receiver.studentId))) {
      fail('names a receiver that is not an ID');
    }
  }
}

/** The payload of the job, with one entry per person (the first child named wins) and no empty values. */
export function payloadOfNotice(notice: Notice): NoticePayload {
  const receivers = new Map<string, string | null>();
  for (const receiver of notice.receivers) {
    if (!receivers.has(receiver.userId)) receivers.set(receiver.userId, receiver.studentId ?? null);
  }
  return {
    sourceKey: notice.sourceKey,
    occurredAt: notice.occurredAt.toISOString(),
    category: notice.category,
    tab: notice.tab,
    title: notice.title,
    body: notice.body,
    senderDisplayName: notice.senderDisplayName ?? null,
    target: notice.target ?? null,
    receivers: [...receivers].map(([userId, studentId]) => ({ userId, studentId })),
  };
}

/** Reads a job's payload back; a payload that is not one is an error the job fails on. */
export function noticeOfPayload(payload: unknown): NoticePayload {
  const value = (payload ?? {}) as Partial<NoticePayload>;
  if (
    typeof value.sourceKey !== 'string' ||
    typeof value.occurredAt !== 'string' ||
    Number.isNaN(Date.parse(value.occurredAt)) ||
    typeof value.category !== 'number' ||
    !INBOX_TABS.includes(value.tab as InboxTab) ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    !Array.isArray(value.receivers) ||
    value.receivers.some(
      (r) => !isUuid(r?.userId) || (r.studentId !== null && !isUuid(r.studentId)),
    )
  ) {
    throw new Error('A notify job needs a notice');
  }
  return value as NoticePayload;
}
