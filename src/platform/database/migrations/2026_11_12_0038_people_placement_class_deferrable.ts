import { sql, type Kysely } from 'kysely';

/**
 * People, part 13 (STU-12): correcting a student's class rewrites the class of the enrolment and of its placements in
 * one transaction. A placement names its enrolment and the enrolment's class together, so the one key is checked at
 * the end of the transaction instead of the end of each statement; no other key changes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table student_section_placements
      alter constraint fk_placements_enrolment_class deferrable initially immediate
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the deferrable placement class key in production');
  }
  await sql`
    alter table student_section_placements
      alter constraint fk_placements_enrolment_class not deferrable
  `.execute(db);
}
