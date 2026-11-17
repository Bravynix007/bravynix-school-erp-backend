import { notificationResource } from './notifications.resource.js';
import type { InboxRow } from './notifications.repository.js';

const base: Omit<InboxRow, 'cursorAt'> = {
  id: 'n-1',
  created_at: new Date('2026-11-16T09:00:00.000Z'),
  society_id: 'soc-1',
  institution_id: 'ins-1',
  student_id: 'stu-1',
  category: 2,
  inbox_tab: 1,
  title: 'Diary',
  body: 'New diary entry',
  sender_display_name: 'Ms Rao',
  target_type: 3,
  target_id: 'd-1',
  read_at: null,
};

describe('notificationResource', () => {
  it('shapes an unread item with its target', () => {
    expect(notificationResource(base)).toEqual({
      id: 'n-1',
      createdAt: '2026-11-16T09:00:00.000Z',
      category: 2,
      tab: 1,
      title: 'Diary',
      body: 'New diary entry',
      senderDisplayName: 'Ms Rao',
      institutionId: 'ins-1',
      studentId: 'stu-1',
      target: { type: 3, id: 'd-1' },
      isRead: false,
      readAt: null,
    });
  });

  it('has no target when either half is missing, and shows when it was read', () => {
    const read = notificationResource({
      ...base,
      target_id: null,
      read_at: new Date('2026-11-16T09:30:00.000Z'),
    });
    expect(read.target).toBeNull();
    expect(read).toMatchObject({ isRead: true, readAt: '2026-11-16T09:30:00.000Z' });
  });
});
