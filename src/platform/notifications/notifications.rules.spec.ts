import {
  MAX_BODY,
  MAX_RECEIVERS,
  MAX_SOURCE_KEY,
  MAX_TITLE,
  checkNotice,
  noticeOfPayload,
  payloadOfNotice,
  type Notice,
} from './notifications.rules.js';

const USER = '0198f0a0-0000-7000-8000-000000000001';
const OTHER = '0198f0a0-0000-7000-8000-000000000002';
const CHILD = '0198f0a0-0000-7000-8000-000000000003';

const notice = (fields: Partial<Notice> = {}): Notice => ({
  societyId: '0198f0a0-0000-7000-8000-0000000000aa',
  institutionId: null,
  sourceKey: 'absent:s1:e1',
  occurredAt: new Date('2026-11-16T04:30:00.000Z'),
  category: 1,
  tab: 1,
  title: 'Absent',
  body: 'Marked absent',
  receivers: [{ userId: USER }],
  ...fields,
});

describe('checkNotice', () => {
  it('takes a well formed notice, at the limits', () => {
    expect(() =>
      checkNotice(
        notice({
          sourceKey: 'k'.repeat(MAX_SOURCE_KEY),
          title: 't'.repeat(MAX_TITLE),
          body: 'b'.repeat(MAX_BODY),
          target: { type: 12, id: CHILD, date: '2026-02-28' },
          receivers: Array.from({ length: MAX_RECEIVERS }, () => ({ userId: USER })),
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['an empty source key', { sourceKey: '' }, /source key/],
    ['a source key that is too long', { sourceKey: 'k'.repeat(MAX_SOURCE_KEY + 1) }, /source key/],
    ['a category above 10', { category: 11 }, /category/],
    ['a category below 0', { category: -1 }, /category/],
    ['a category that is not a whole number', { category: 1.5 }, /category/],
    ['a tab outside 1 to 4', { tab: 5 as never }, /tab/],
    ['a blank title', { title: '  ' }, /title/],
    ['a title that is too long', { title: 't'.repeat(MAX_TITLE + 1) }, /title/],
    ['a body that is too long', { body: 'b'.repeat(MAX_BODY + 1) }, /body/],
    ['a sender that is too long', { senderDisplayName: 's'.repeat(201) }, /sender/],
    ['an Institution that is not an ID', { institutionId: 'x' }, /Institution/],
    ['a screen that does not exist', { target: { type: 13, id: CHILD } }, /screen/],
    ['a screen with no ID', { target: { type: 1, id: 'x' } }, /screen/],
    ['a day that does not exist', { target: { type: 2, id: CHILD, date: '2026-02-30' } }, /day/],
    ['a day written another way', { target: { type: 2, id: CHILD, date: '2/3/2026' } }, /day/],
    [
      'too many receivers',
      { receivers: Array.from({ length: MAX_RECEIVERS + 1 }, () => ({ userId: USER })) },
      /receivers/,
    ],
    ['a receiver that is not an ID', { receivers: [{ userId: 'x' }] }, /receiver/],
    ['a child that is not an ID', { receivers: [{ userId: USER, studentId: 'x' }] }, /receiver/],
  ])('refuses %s', (_name, fields, message) => {
    expect(() => checkNotice(notice(fields))).toThrow(message);
  });
});

describe('payloadOfNotice', () => {
  it('keeps one entry for each person, the first child named, and the notice time as text', () => {
    const payload = payloadOfNotice(
      notice({
        receivers: [
          { userId: USER, studentId: CHILD },
          { userId: OTHER },
          { userId: USER, studentId: null },
        ],
      }),
    );
    expect(payload.receivers).toEqual([
      { userId: USER, studentId: CHILD },
      { userId: OTHER, studentId: null },
    ]);
    expect(payload.occurredAt).toBe('2026-11-16T04:30:00.000Z');
    expect(payload).toMatchObject({ senderDisplayName: null, target: null });
  });

  it('holds no Society or Institution: the job record carries them', () => {
    expect(Object.keys(payloadOfNotice(notice()))).not.toEqual(
      expect.arrayContaining(['societyId', 'institutionId']),
    );
  });
});

describe('noticeOfPayload', () => {
  it('reads back what payloadOfNotice wrote', () => {
    const payload = payloadOfNotice(notice({ target: { type: 2, id: CHILD, date: '2026-11-21' } }));
    expect(noticeOfPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it.each([
    ['nothing', undefined],
    ['no receivers list', { ...payloadOfNotice(notice()), receivers: 'x' }],
    [
      'a receiver that is not an ID',
      { ...payloadOfNotice(notice()), receivers: [{ userId: 'x', studentId: null }] },
    ],
    ['a time that is not a time', { ...payloadOfNotice(notice()), occurredAt: 'later' }],
    ['a tab that does not exist', { ...payloadOfNotice(notice()), tab: 9 }],
  ])('refuses a payload with %s', (_name, payload) => {
    expect(() => noticeOfPayload(payload)).toThrow('A notify job needs a notice');
  });
});
