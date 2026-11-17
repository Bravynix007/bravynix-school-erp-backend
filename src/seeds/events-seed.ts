import { sql, type Kysely } from 'kysely';
import { clearScope, scopeTo } from './academic-seed.js';
import { institutions } from './two-worlds.js';

interface SeedEvent {
  /** The Institution it belongs to, or null for an event of the whole Society (written under the Owner's role). */
  institution: 'A1' | 'A2' | 'B1' | null;
  /** The Society of a Society-wide event, through one of its Institutions. */
  home: 'A1' | 'B1';
  title: string;
  startDate: string;
  endDate: string;
  durationLabel: string;
  audience: 1 | 2 | 3;
  /** A holiday names its type and who it is for, and the predefined classes it is limited to. */
  holiday?: { type: number; students: boolean; staff: boolean; classes: number };
}

const seedId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

const events: readonly SeedEvent[] = [
  {
    institution: null,
    home: 'A1',
    title: 'Founders Day',
    startDate: '2026-11-20',
    endDate: '2026-11-20',
    durationLabel: '1 Day Holiday',
    audience: 1,
    holiday: { type: 1, students: true, staff: true, classes: 0 },
  },
  {
    institution: 'A1',
    home: 'A1',
    title: 'Annual Day',
    startDate: '2026-12-22',
    endDate: '2026-12-24',
    durationLabel: '3 Days',
    audience: 1,
  },
  {
    institution: 'A1',
    home: 'A1',
    title: 'Staff Meeting',
    startDate: '2026-12-01',
    endDate: '2026-12-01',
    durationLabel: '1 Day',
    audience: 3,
  },
  {
    institution: 'A1',
    home: 'A1',
    title: 'Primary Sports Holiday',
    startDate: '2026-12-10',
    endDate: '2026-12-10',
    durationLabel: '1 Day Holiday',
    audience: 2,
    holiday: { type: 3, students: true, staff: false, classes: 2 },
  },
  {
    institution: 'A2',
    home: 'A1',
    title: 'Science Fair',
    startDate: '2027-01-15',
    endDate: '2027-01-16',
    durationLabel: '2 Days',
    audience: 2,
  },
  {
    institution: null,
    home: 'B1',
    title: 'Founders Day',
    startDate: '2026-11-20',
    endDate: '2026-11-20',
    durationLabel: '1 Day Holiday',
    audience: 1,
    holiday: { type: 1, students: true, staff: true, classes: 0 },
  },
  {
    institution: 'B1',
    home: 'B1',
    title: 'Annual Day',
    startDate: '2026-12-18',
    endDate: '2026-12-18',
    durationLabel: '1 Day',
    audience: 1,
  },
  {
    institution: 'B1',
    home: 'B1',
    title: 'Exam Break',
    startDate: '2027-02-01',
    endDate: '2027-02-05',
    durationLabel: '5 Days Holiday',
    audience: 2,
    holiday: { type: 2, students: true, staff: false, classes: 1 },
  },
];

/**
 * Each world's calendar: a Society-wide holiday, Institution events for each audience, and holidays limited to
 * classes. A Society-wide event is written under the Owner's role, as the policy asks. Safe to run twice.
 */
export async function writeEventsSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

async function writeIn(tx: Kysely<unknown>): Promise<void> {
  for (const [index, event] of events.entries()) {
    const home = institutions.find((i) => i.key === event.home)!;
    const institution = event.institution
      ? institutions.find((i) => i.key === event.institution)!
      : null;
    const id = seedId(6001 + index);
    const societyId = await scopeTo(tx, (institution ?? home).id, `event ${event.title}`);
    if (institution === null) await sql`select set_config('app.role_code', '2', true)`.execute(tx);
    await sql`
      insert into events (id, society_id, scope, institution_id, title, start_date, end_date, duration_label,
        audience, is_holiday, holiday_type, holiday_for_students, holiday_for_staff)
      values (${id}, ${societyId}, ${institution === null ? 1 : 2}, ${institution?.id ?? null}, ${event.title},
        ${event.startDate}, ${event.endDate}, ${event.durationLabel}, ${event.audience},
        ${event.holiday !== undefined}, ${event.holiday?.type ?? null}, ${event.holiday?.students ?? false},
        ${event.holiday?.staff ?? false})
      on conflict (id) do nothing
    `.execute(tx);
    if (event.holiday && event.holiday.classes > 0) {
      await sql`
        insert into event_holiday_classes (event_id, predefined_class_id, society_id)
        select ${id}, p.id, ${societyId}
        from (select id from predefined_classes order by code limit ${event.holiday.classes}) p
        on conflict do nothing
      `.execute(tx);
    }
  }
  await clearScope(tx);
}
