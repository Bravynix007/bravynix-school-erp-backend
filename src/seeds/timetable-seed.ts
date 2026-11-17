import { sql, type Kysely } from 'kysely';
import { clearScope, scopeTo, seededYearId } from './academic-seed.js';
import { institutions } from './two-worlds.js';

interface SeedPeriod {
  periodNo: number;
  label: string;
  startTime: string;
  endTime: string;
  isBreak: boolean;
}

const seedId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

/** The school day of every two-worlds Institution: eight periods of 40 minutes with lunch after the fourth. */
const periods: readonly SeedPeriod[] = [
  { periodNo: 1, label: 'Period 1', startTime: '08:30', endTime: '09:10', isBreak: false },
  { periodNo: 2, label: 'Period 2', startTime: '09:10', endTime: '09:50', isBreak: false },
  { periodNo: 3, label: 'Period 3', startTime: '09:50', endTime: '10:30', isBreak: false },
  { periodNo: 4, label: 'Period 4', startTime: '10:30', endTime: '11:10', isBreak: false },
  { periodNo: 5, label: 'Lunch', startTime: '11:10', endTime: '11:50', isBreak: true },
  { periodNo: 6, label: 'Period 5', startTime: '11:50', endTime: '12:30', isBreak: false },
  { periodNo: 7, label: 'Period 6', startTime: '12:30', endTime: '13:10', isBreak: false },
  { periodNo: 8, label: 'Period 7', startTime: '13:10', endTime: '13:50', isBreak: false },
  { periodNo: 9, label: 'Period 8', startTime: '13:50', endTime: '14:30', isBreak: false },
];

/** The seeded period of this number in a two-worlds Institution, so a test can find its row. */
function seededTimeSlotId(institutionKey: string, periodNo: number): string {
  const index = institutions.findIndex((i) => i.key === institutionKey);
  if (index < 0) throw new Error(`Unknown two-worlds Institution ${institutionKey}`);
  if (!periods.some((p) => p.periodNo === periodNo))
    throw new Error(`No seeded period ${periodNo}`);
  return seedId(7001 + index * 100 + periodNo);
}

/** Each Institution's periods in its current year. Safe to run twice. */
export async function writeTimetableSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

async function writeIn(tx: Kysely<unknown>): Promise<void> {
  for (const institution of institutions) {
    const societyId = await scopeTo(tx, institution.id, `periods of ${institution.key}`);
    for (const period of periods) {
      await sql`
        insert into time_slots (id, society_id, institution_id, academic_year_id, period_no, label, start_time,
          end_time, is_break)
        values (${seededTimeSlotId(institution.key, period.periodNo)}, ${societyId}, ${institution.id},
          ${seededYearId(institution.key)}, ${period.periodNo}, ${period.label}, ${period.startTime},
          ${period.endTime}, ${period.isBreak})
        on conflict (id) do nothing
      `.execute(tx);
    }
  }
  await clearScope(tx);
}
