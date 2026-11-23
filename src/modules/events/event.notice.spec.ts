import type { EventRow } from './event.repository.js';
import { eventNotice } from './event.notice.js';

const row: EventRow = {
  id: 'event-1',
  created_at: new Date('2026-11-01T05:00:00.000Z'),
  created_by: 'owner-1',
  updated_at: new Date('2026-11-03T05:00:00.000Z'),
  updated_by: 'owner-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  scope: 2,
  institution_id: 'inst-1',
  title: 'Annual Day',
  description: 'Prizes and dances',
  venue: null,
  start_date: '2026-12-22',
  end_date: '2026-12-24',
  duration_label: '3 Days',
  audience: 1,
  preset_image_code: null,
  image_file_id: null,
  is_holiday: false,
  holiday_type: null,
  holiday_for_students: false,
  holiday_for_staff: false,
};

describe('eventNotice', () => {
  it('tells a new event with its days, to the receivers, keyed by the event and its version', () => {
    expect(eventNotice(row, 'created', ['a', 'b'])).toEqual({
      societyId: 'society-1',
      institutionId: 'inst-1',
      sourceKey: 'event:event-1:v1',
      occurredAt: row.created_at,
      category: 3,
      tab: 2,
      title: 'New event: Annual Day',
      body: '22 Dec 2026 to 24 Dec 2026',
      target: { type: 3, id: 'event-1' },
      receivers: [{ userId: 'a' }, { userId: 'b' }],
    });
  });

  it('says one day once, and the place when there is one', () => {
    const notice = eventNotice(
      { ...row, end_date: row.start_date, venue: 'Main Hall' },
      'created',
      ['a'],
    );
    expect(notice.body).toBe('22 Dec 2026 at Main Hall');
  });

  it('tells a holiday as one, and a change as an update with the time of the change and the new version', () => {
    expect(eventNotice({ ...row, is_holiday: true }, 'created', ['a']).title).toBe(
      'Holiday: Annual Day',
    );
    const changed = eventNotice({ ...row, version: 4, is_holiday: true }, 'updated', ['a']);
    expect(changed).toMatchObject({
      title: 'Updated: Annual Day',
      sourceKey: 'event:event-1:v4',
      occurredAt: row.updated_at,
    });
  });

  it('files the notice under the tab of its audience, and has no Institution for a Society event', () => {
    expect(eventNotice({ ...row, audience: 2 }, 'created', ['a']).tab).toBe(4);
    expect(eventNotice({ ...row, audience: 3 }, 'created', ['a']).tab).toBe(3);
    expect(eventNotice({ ...row, scope: 1, institution_id: null }, 'created', ['a'])).toMatchObject(
      {
        institutionId: null,
      },
    );
  });

  it('carries no ID but the one that opens the event, and no description', () => {
    const notice = eventNotice(row, 'created', ['a']);
    expect(JSON.stringify({ title: notice.title, body: notice.body })).not.toMatch(
      /inst-1|society-1|Prizes/,
    );
  });
});
