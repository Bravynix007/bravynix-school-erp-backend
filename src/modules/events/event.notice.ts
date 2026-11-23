import type { Notice } from '../../platform/notifications/index.js';
import type { EventRow } from './event.repository.js';
import { formatDay } from '../../common/time/format-day.js';
import { inboxTabOf } from './event.rules.js';

/** The screen a notice about an event opens (DDD 9.8). */
const EVENT_TARGET = 3;
/** The category of the notices about events and holidays (DDD 9.8). */
const EVENT_CATEGORY = 3;

/** What an audience is told: a new event, or a change to one. */
export type EventNoticeKind = 'created' | 'updated';

/**
 * The notice to the people an event is for (PRD 7.12, API design 10.26): the title, and the days and the place, which
 * are what the event screen shows and never more (SDD 18). Its key is the event and its version, so the notice of a
 * change is a new one, and the job that writes it can run twice without telling anyone twice.
 */
export function eventNotice(
  event: EventRow,
  kind: EventNoticeKind,
  receivers: readonly string[],
): Notice {
  const lead = kind === 'updated' ? 'Updated' : event.is_holiday ? 'Holiday' : 'New event';
  const days =
    event.start_date === event.end_date
      ? formatDay(event.start_date)
      : `${formatDay(event.start_date)} to ${formatDay(event.end_date)}`;
  return {
    societyId: event.society_id,
    institutionId: event.institution_id,
    sourceKey: `event:${event.id}:v${event.version.toString()}`,
    occurredAt: kind === 'updated' ? event.updated_at : event.created_at,
    category: EVENT_CATEGORY,
    tab: inboxTabOf(event.audience),
    title: `${lead}: ${event.title}`,
    body: event.venue === null ? days : `${days} at ${event.venue}`,
    target: { type: EVENT_TARGET, id: event.id },
    receivers: receivers.map((userId) => ({ userId })),
  };
}
