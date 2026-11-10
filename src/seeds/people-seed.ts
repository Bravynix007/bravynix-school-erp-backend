import { sql, type Kysely } from 'kysely';
import { classes, clearScope, scopeTo, seededYearId } from './academic-seed.js';
import { institutions, personas } from './two-worlds.js';

const seedId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

/** The staff members of the two worlds: every persona with a Teacher and Staff grant, in the order of the personas. */
export const seededStaff = personas
  .filter((persona) => persona.grants.some((grant) => grant.role === 4))
  .map((persona, index) => {
    const grant = persona.grants.find((candidate) => candidate.role === 4)!;
    const home = institutions.find((institution) => institution.key === grant.institutions?.[0]);
    if (!home) throw new Error(`Seeded teacher ${persona.key} names no home Institution`);
    return { persona, grant, home, id: seedId(3401 + index), index };
  })
  // The place of each at their home Institution, counted from the first: 0 for the first staff member there.
  .map((staff, _index, all) => ({
    ...staff,
    place: all.filter((other) => other.home.id === staff.home.id && other.index < staff.index)
      .length,
  }));

/** The seeded staff member of a persona, so a test can find its record. */
export const seededStaffId = (personaKey: string): string => {
  const found = seededStaff.find((staff) => staff.persona.key === personaKey);
  if (!found) throw new Error(`Seeded persona ${personaKey} has no staff record`);
  return found.id;
};

/**
 * A staff record for each two-worlds persona that holds the Teacher and Staff role, at the first Institution of the
 * grant, each with one education, one emergency contact, one subject, an empty identity row and one document, so a test can show one Society's people are
 * hidden from another. Each also teaches that subject in a section of the home Institution for its current year, and
 * the first ones there lead a section each (the teacher at place `n` takes the `n`-th section, the class teacher
 * only while there are sections left). The Institutions of a grant after the first are the member's extra Institutions. The pending,
 * blocked and inactive accounts have records too: the account state is the login's, not the record's. Safe to run
 * twice: rows are keyed by their fixed IDs. The numbers are made up (the 900000 range).
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
  for (const { persona, grant, home, id, index, place } of seededStaff) {
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
      insert into staff_subjects (staff_member_id, subject_id, society_id)
      select ${id}, id, society_id from subjects
      where society_id = ${societyId} and code = 'MATH'
      on conflict do nothing
    `.execute(tx);
    for (const key of grant.institutions?.slice(1) ?? []) {
      const extra = institutions.find((institution) => institution.key === key);
      if (!extra) throw new Error(`Seeded teacher ${persona.key} names an unknown Institution`);
      await sql`
        insert into staff_institutions (staff_member_id, institution_id, society_id)
        values (${id}, ${extra.id}, ${societyId})
        on conflict do nothing
      `.execute(tx);
    }
    const sections = classes
      .filter((entry) => entry.institutionId === home.id)
      .flatMap((entry) => entry.sections);
    const section = sections[place % sections.length];
    if (section) {
      const yearId = seededYearId(home.key);
      await sql`
        insert into teaching_assignments
          (id, society_id, institution_id, academic_year_id, section_id, subject_id, staff_member_id)
        select ${seedId(3701 + index)}, ${societyId}, ${home.id}, ${yearId}, ${section.id}, id, ${id}
        from subjects where society_id = ${societyId} and code = 'MATH'
        on conflict (id) do nothing
      `.execute(tx);
    }
    const leads = sections[place];
    if (leads) {
      await sql`
        insert into class_teacher_assignments
          (id, society_id, institution_id, academic_year_id, section_id, staff_member_id)
        values (${seedId(3801 + index)}, ${societyId}, ${home.id}, ${seededYearId(home.key)},
          ${leads.id}, ${id})
        on conflict (id) do nothing
      `.execute(tx);
    }
    // No number is seeded (nothing here is a real person's): the row stands for a record whose Aadhaar is not set yet.
    await sql`
      insert into staff_identities (staff_member_id, society_id)
      values (${id}, ${societyId})
      on conflict (staff_member_id) do nothing
    `.execute(tx);
    // One Ready staff document, as FIL-01, FIL-02 and STF-15 would leave it. No object is stored behind it.
    await sql`
      insert into files
        (id, society_id, institution_id, storage_bucket, object_key, purpose, content_type, size_bytes,
         original_filename, file_status, confirmed_at)
      values (${seedId(3901 + index)}, ${societyId}, ${home.id}, 1,
        ${`${societyId}/${home.id}/6/seeded-${index.toString()}`}, 6, 'application/pdf', 2048,
        'appointment-letter.pdf', 2, now())
      on conflict (id) do nothing
    `.execute(tx);
    await sql`
      insert into documents (id, society_id, institution_id, owner_type, staff_member_id, title, file_id)
      values (${seedId(4001 + index)}, ${societyId}, ${home.id}, 2, ${id}, 'Appointment letter',
        ${seedId(3901 + index)})
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
