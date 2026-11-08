import { sql, type Kysely } from 'kysely';
import { clearScope, scopeTo } from './academic-seed.js';
import { institutions, personas } from './two-worlds.js';

const seedId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

/** The staff members of the two worlds: every persona with a Teacher and Staff grant, in the order of the personas. */
export const seededStaff = personas
  .filter((persona) => persona.grants.some((grant) => grant.role === 4))
  .map((persona, index) => {
    const grant = persona.grants.find((candidate) => candidate.role === 4)!;
    const home = institutions.find((institution) => institution.key === grant.institutions?.[0]);
    if (!home) throw new Error(`Seeded teacher ${persona.key} names no home Institution`);
    return { persona, home, id: seedId(3401 + index), index };
  });

/** The seeded staff member of a persona, so a test can find its record. */
export const seededStaffId = (personaKey: string): string => {
  const found = seededStaff.find((staff) => staff.persona.key === personaKey);
  if (!found) throw new Error(`Seeded persona ${personaKey} has no staff record`);
  return found.id;
};

/**
 * A staff record for each two-worlds persona that holds the Teacher and Staff role, at the first Institution of the
 * grant, each with one education and one emergency contact, so a test can show one Society's people are hidden from
 * another. The pending, blocked and inactive accounts have records too: the account state is the login's, not the
 * record's. Safe to run twice: rows are keyed by their fixed IDs. The numbers are made up (the 900000 range).
 */
export async function writeStaffSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

async function writeIn(tx: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{
    id: string;
  }>`select id from class_categories order by display_order limit 1`.execute(tx);
  const categoryId = rows[0]?.id;
  if (!categoryId) throw new Error('Seeded staff need a class category: run the migrations first');
  for (const { persona, home, id, index } of seededStaff) {
    const societyId = await scopeTo(tx, home.id, 'staff member');
    const [firstName, ...rest] = persona.displayName.split(' ');
    await sql`
      insert into staff_members
        (id, society_id, home_institution_id, user_id, employee_code, first_name, last_name, class_category_id,
         country_code, mobile_number, joining_date)
      values (${id}, ${societyId}, ${home.id}, ${persona.id}, ${`EMP-${persona.key}`}, ${firstName ?? persona.key},
        ${rest.join(' ') || null}, ${categoryId}, '91', ${`9000000${(100 + index).toString()}`}, '2024-06-03')
      on conflict (id) do nothing
    `.execute(tx);
    await sql`
      insert into staff_educations (id, society_id, staff_member_id, degree, specialization, institution_name, year_of_passing)
      values (${seedId(3501 + index)}, ${societyId}, ${id}, 'B.Ed', 'Mathematics', 'Seeded Training College', 2015)
      on conflict (id) do nothing
    `.execute(tx);
    await sql`
      insert into staff_emergency_contacts
        (id, society_id, staff_member_id, contact_name, relation, country_code, phone_number, is_primary)
      values (${seedId(3601 + index)}, ${societyId}, ${id}, 'Seeded Contact', 'Spouse', '91',
        ${`9000001${(100 + index).toString()}`}, true)
      on conflict (id) do nothing
    `.execute(tx);
  }
  await clearScope(tx);
}
