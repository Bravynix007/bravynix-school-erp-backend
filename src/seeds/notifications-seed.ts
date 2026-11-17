import { sql, type Kysely } from 'kysely';
import { clearScope, scopeTo } from './academic-seed.js';
import { institutions, personaByKey } from './two-worlds.js';

/** Who has a notice waiting: each world's first Owner (Society wide) and its first Admin (their Institution). */
const receivers = [
  { persona: 'SO-A1', institution: null, home: 'A1' },
  { persona: 'IA-A1', institution: 'A1', home: 'A1' },
  { persona: 'SO-B1', institution: null, home: 'B1' },
  { persona: 'IA-B1', institution: 'B1', home: 'B1' },
] as const;

const seedId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

/** The seeded notice of a receiver, so a test can find its row. */
export const seededInboxItemId = (personaKey: string): string => {
  const index = receivers.findIndex((r) => r.persona === personaKey);
  if (index < 0) throw new Error(`No seeded inbox item for ${personaKey}`);
  return seedId(5001 + index);
};

/**
 * One notice in the inbox of each world's Owner and Admin, so a test can show an inbox is its receiver's alone. The
 * notice is stamped at the first of the current month, which has a partition and stays the same all month, so a
 * second run adds nothing. Safe to run twice.
 */
export async function writeNotificationsSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

async function writeIn(tx: Kysely<unknown>): Promise<void> {
  for (const receiver of receivers) {
    const home = institutions.find((i) => i.key === receiver.home)!;
    const societyId = await scopeTo(tx, home.id, 'inbox item');
    const institutionId = receiver.institution === null ? null : home.id;
    // ON CONFLICT also reads the row it meets, which only its receiver may do.
    await sql`select set_config('app.person_id', ${personaByKey(receiver.persona).id}, true)`.execute(
      tx,
    );
    await sql`
      insert into inbox_items
        (id, created_at, user_id, society_id, institution_id, category, inbox_tab, title, body, source_key)
      values (${seededInboxItemId(receiver.persona)}, date_trunc('month', now()),
        ${personaByKey(receiver.persona).id}, ${societyId}, ${institutionId}, 3, 2,
        'Welcome to the school year', 'This is a seeded notice.', ${`seed:${receiver.persona}`})
      on conflict (user_id, source_key, created_at) do nothing
    `.execute(tx);
  }
  await sql`select set_config('app.person_id', '', true)`.execute(tx);
  await clearScope(tx);
}
