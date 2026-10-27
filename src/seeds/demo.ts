import { sql, type Kysely } from 'kysely';

/**
 * The "demo" scenario: a small, realistic set of Phase 1 data for showing the console and the app side by side
 * (`docs/DEMO.md` in the project files). Two Societies, three Institutions, two Owners (one of them in both
 * Societies, so the app shows the role chooser) and two Institution Admins (one per Institution of the first
 * Society, so blocking one Institution's staff leaves the other's working).
 *
 * Every email uses the reserved `.test` domain, so nothing can ever be delivered; the API's local mail catcher
 * shows what it would have sent. There are no passwords and no keys: login is by email code, and a Super Admin
 * enrols an authenticator on first sign-in. Safe to run twice: rows are keyed by their fixed IDs.
 *
 * Teachers, students and parents wait for the People module, so none are seeded. Institution Admin grants are
 * written directly, as the Super Admin console and the app cannot add staff yet.
 */

const id = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

export interface DemoPerson {
  key: string;
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface DemoSociety {
  id: string;
  code: string;
  name: string;
  description: string;
  email: string;
  line1: string;
  pincode: string;
}

export interface DemoInstitution {
  id: string;
  society: DemoSociety['code'];
  code: string;
  name: string;
  place: string;
  line1: string;
  pincode: string;
}

const person = (key: string, n: number, firstName: string, lastName: string): DemoPerson => ({
  key,
  id: id(n),
  email: `${key}@demo.test`,
  firstName,
  lastName,
});

export const superAdmin = person('admin', 9301, 'Priya', 'Menon');
export const asha = person('asha.rao', 9302, 'Asha', 'Rao');
export const meera = person('meera.iyer', 9303, 'Meera', 'Iyer');
export const kavita = person('kavita.nair', 9304, 'Kavita', 'Nair');
export const suresh = person('suresh.babu', 9305, 'Suresh', 'Babu');

export const societies: DemoSociety[] = [
  {
    id: id(9101),
    code: 'SVES',
    name: 'Sri Vidya Educational Society',
    description: 'A charitable trust running two schools in Bengaluru.',
    email: 'office@svs.demo.test',
    line1: '12 MG Road',
    pincode: '560001',
  },
  {
    id: id(9102),
    code: 'NET',
    name: 'Navodaya Education Trust',
    description: 'A trust running a public school in Mysuru.',
    email: 'office@navodaya.demo.test',
    line1: '4 Temple Street',
    pincode: '570001',
  },
];

export const institutions: DemoInstitution[] = [
  {
    id: id(9201),
    society: 'SVES',
    code: 'SVHS',
    name: 'Sri Vidya High School',
    place: 'Bengaluru',
    line1: '12 MG Road',
    pincode: '560001',
  },
  {
    id: id(9202),
    society: 'SVES',
    code: 'SVPS',
    name: 'Sri Vidya Primary School',
    place: 'Bengaluru',
    line1: '30 Park Lane',
    pincode: '560002',
  },
  {
    id: id(9203),
    society: 'NET',
    code: 'NPS',
    name: 'Navodaya Public School',
    place: 'Mysuru',
    line1: '4 Temple Street',
    pincode: '570001',
  },
];

/** Who is the Owner of which Society, in seat order. Asha owns both, so her app offers a choice. */
export const owners: { person: DemoPerson; society: DemoSociety['code'] }[] = [
  { person: asha, society: 'SVES' },
  { person: meera, society: 'SVES' },
  { person: asha, society: 'NET' },
];

/** Institution Admins: one per Institution of Sri Vidya. */
export const admins: {
  person: DemoPerson;
  institution: DemoInstitution['code'];
  staffMemberId: string;
}[] = [
  { person: kavita, institution: 'SVHS', staffMemberId: id(9401) },
  { person: suresh, institution: 'SVPS', staffMemberId: id(9402) },
];

export const people: DemoPerson[] = [superAdmin, asha, meera, kavita, suresh];

const societyOf = (code: string): DemoSociety => {
  const found = societies.find((s) => s.code === code);
  if (!found) throw new Error(`Unknown demo Society ${code}`);
  return found;
};

const institutionOf = (code: string): DemoInstitution => {
  const found = institutions.find((i) => i.code === code);
  if (!found) throw new Error(`Unknown demo Institution ${code}`);
  return found;
};

export async function writeDemoSeed(db: Kysely<unknown>): Promise<void> {
  // The tenant roots force row-level security even on their owner, so the seed writes as Super Admin.
  await sql`select set_config('app.role_code', '1', true)`.execute(db);

  for (const p of people) {
    await sql`
      insert into users (id, email, first_name, last_name, account_status)
      values (${p.id}, ${p.email}, ${p.firstName}, ${p.lastName}, 1)
      on conflict (id) do nothing
    `.execute(db);
  }

  for (const s of societies) {
    await sql`
      insert into societies (id, code, name, description, email, address_line_1, pincode, created_by, updated_by)
      values (${s.id}, ${s.code}, ${s.name}, ${s.description}, ${s.email}, ${s.line1}, ${s.pincode},
        ${superAdmin.id}, ${superAdmin.id})
      on conflict (id) do nothing
    `.execute(db);
  }
  for (const i of institutions) {
    await sql`
      insert into institutions (id, society_id, code, name, place, address_line_1, pincode, created_by, updated_by)
      values (${i.id}, ${societyOf(i.society).id}, ${i.code}, ${i.name}, ${i.place}, ${i.line1}, ${i.pincode},
        ${superAdmin.id}, ${superAdmin.id})
      on conflict (id) do nothing
    `.execute(db);
  }

  await sql`
    insert into role_assignments (user_id, role_code, seat_no)
    select ${superAdmin.id}, 1, 1
    where not exists (
      select 1 from role_assignments where user_id = ${superAdmin.id} and role_code = 1 and revoked_at is null
    )
  `.execute(db);

  const seats = new Map<string, number>();
  for (const { person: p, society: code } of owners) {
    const society = societyOf(code);
    const seat = (seats.get(society.id) ?? 0) + 1;
    seats.set(society.id, seat);
    await sql`
      insert into role_assignments (user_id, role_code, society_id, seat_no)
      select ${p.id}, 2, ${society.id}, ${seat}
      where not exists (
        select 1 from role_assignments
        where user_id = ${p.id} and role_code = 2 and society_id = ${society.id} and revoked_at is null
      )
    `.execute(db);
  }

  for (const { person: p, institution: code, staffMemberId } of admins) {
    const institution = institutionOf(code);
    await sql`
      insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
      select ${p.id}, 3, ${societyOf(institution.society).id}, ${institution.id}, ${staffMemberId}
      where not exists (
        select 1 from role_assignments
        where user_id = ${p.id} and role_code = 3 and institution_id = ${institution.id} and revoked_at is null
      )
    `.execute(db);
  }
}
