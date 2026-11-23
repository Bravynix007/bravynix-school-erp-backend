import type { InboxRow } from './notifications.repository.js';

/** One notice in the inbox (NTF-01, NTF-03). The screen it opens is `target`; the push text never carries more. */
export interface NotificationResource {
  id: string;
  createdAt: string;
  category: number;
  tab: number;
  title: string;
  body: string;
  senderDisplayName: string | null;
  institutionId: string | null;
  studentId: string | null;
  target: { type: number; id: string; date: string | null } | null;
  isRead: boolean;
  readAt: string | null;
}

export function notificationResource(row: Omit<InboxRow, 'cursorAt'>): NotificationResource {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    category: row.category,
    tab: row.inbox_tab,
    title: row.title,
    body: row.body,
    senderDisplayName: row.sender_display_name,
    institutionId: row.institution_id,
    studentId: row.student_id,
    target:
      row.target_type !== null && row.target_id !== null
        ? { type: row.target_type, id: row.target_id, date: row.target_date }
        : null,
    isRead: row.read_at !== null,
    readAt: row.read_at?.toISOString() ?? null,
  };
}
