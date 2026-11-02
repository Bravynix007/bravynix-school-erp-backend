import { sql, type Kysely } from 'kysely';
import {
  commonSubjects,
  insertAcademicYears,
  insertClassesOffered,
  insertSubjects,
  type SeedAcademicYear,
  type SeedClassesOffered,
  type SeedSubject,
} from './academic-seed.js';
import { DueStatus, dueAmounts } from '../modules/platform-billing/due.rules.js';

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
    code: 'LET',
    name: 'Lakeshore Education Trust',
    description: 'A trust running a public school in Mysuru.',
    email: 'office@lakeshore.demo.test',
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
    society: 'LET',
    code: 'LPS',
    name: 'Lakeshore Public School',
    place: 'Mysuru',
    line1: '4 Temple Street',
    pincode: '570001',
  },
];

/** Each Institution's current year, and for the first a finished one before it, so the year list shows history. */
export const academicYears: SeedAcademicYear[] = [
  {
    id: id(9701),
    institutionId: id(9201),
    name: '2025-2026',
    startDate: '2025-06-01',
    endDate: '2026-03-31',
    isCurrent: false,
  },
  {
    id: id(9702),
    institutionId: id(9201),
    name: '2026-2027',
    startDate: '2026-06-01',
    endDate: '2027-03-31',
    isCurrent: true,
  },
  {
    id: id(9703),
    institutionId: id(9202),
    name: '2026-2027',
    startDate: '2026-06-01',
    endDate: '2027-03-31',
    isCurrent: true,
  },
  {
    id: id(9704),
    institutionId: id(9203),
    name: '2026-2027',
    startDate: '2026-06-01',
    endDate: '2027-03-31',
    isCurrent: true,
  },
];

/** What each Institution offers: the two schools the primary and high school classes, the primary school the early years. */
export const classesOffered: SeedClassesOffered[] = [
  { institutionId: id(9201), categories: ['LOWER_PRIMARY', 'HIGHER_PRIMARY', 'HIGH_SCHOOL'] },
  { institutionId: id(9202), categories: ['PRE_SCHOOL', 'NURSERY', 'LOWER_PRIMARY'] },
  { institutionId: id(9203), categories: ['LOWER_PRIMARY', 'HIGHER_PRIMARY', 'HIGH_SCHOOL'] },
];

/** Both Societies start with the common subjects; the first adds Hindi, so the lists differ. */
export const subjects: SeedSubject[] = [
  ...commonSubjects.map((subject, n) => ({ id: id(9801 + n), societyId: id(9101), ...subject })),
  { id: id(9805), societyId: id(9101), name: 'Hindi', code: 'HIN' },
  ...commonSubjects.map((subject, n) => ({ id: id(9811 + n), societyId: id(9102), ...subject })),
];

/** Who is the Owner of which Society, in seat order. Asha owns both, so her app offers a choice. */
export const owners: { person: DemoPerson; society: DemoSociety['code'] }[] = [
  { person: asha, society: 'SVES' },
  { person: meera, society: 'SVES' },
  { person: asha, society: 'LET' },
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

/**
 * What BravyNix charges each Institution per student. Sri Vidya High School has
 * two, so the pricing screen shows a history; the dates are fixed so the demo
 * reads the same every day.
 */
export const rates: {
  id: string;
  institution: DemoInstitution['code'];
  amount: string;
  effectiveFrom: string;
  note: string;
}[] = [
  {
    id: id(9501),
    institution: 'SVHS',
    amount: '60.00',
    effectiveFrom: '2026-04-01',
    note: 'Agreed for 2026-27',
  },
  {
    id: id(9502),
    institution: 'SVHS',
    amount: '65.00',
    effectiveFrom: '2026-10-01',
    note: 'Revised after the lab upgrade',
  },
  {
    id: id(9503),
    institution: 'SVPS',
    amount: '45.00',
    effectiveFrom: '2026-04-01',
    note: 'Agreed for 2026-27',
  },
  {
    id: id(9504),
    institution: 'LPS',
    amount: '55.00',
    effectiveFrom: '2026-04-01',
    note: 'Agreed for 2026-27',
  },
];

/** How a seeded due ended: still Due (nothing), paid, or cancelled. */
type DueOutcome =
  | { paid: { date: string; mode: number; reference: string } }
  | { cancelled: { at: string; reason: string } };

/**
 * Dues BravyNix has raised, numbered from the start of the financial year 2026-27 so the first due raised live in the
 * demo is number 7. Each one names the rate seeded for its Institution, so the amounts are exactly what raising it
 * would have given. Two are paid and one is cancelled, so the ledger shows every state.
 */
export const dues: {
  id: string;
  institution: DemoInstitution['code'];
  rateId: string;
  invoiceNo: string;
  periodStartDate: string;
  periodEndDate: string;
  studentCount: number;
  studentCountNote: string;
  adjustmentAmount: string;
  adjustmentNote: string | null;
  dueDate: string;
  outcome?: DueOutcome;
}[] = [
  {
    id: id(9601),
    institution: 'SVHS',
    rateId: id(9501),
    invoiceNo: 'BNX/FY2026-27/0001',
    periodStartDate: '2026-04-01',
    periodEndDate: '2026-09-30',
    studentCount: 300,
    studentCountNote: 'Counted from the admission register',
    adjustmentAmount: '0.00',
    adjustmentNote: null,
    dueDate: '2026-05-15',
    outcome: { paid: { date: '2026-05-10', mode: 2, reference: 'UTR 4821' } },
  },
  {
    id: id(9602),
    institution: 'SVHS',
    rateId: id(9502),
    invoiceNo: 'BNX/FY2026-27/0002',
    periodStartDate: '2026-10-01',
    periodEndDate: '2027-03-31',
    studentCount: 300,
    studentCountNote: 'Counted from the admission register',
    adjustmentAmount: '0.00',
    adjustmentNote: null,
    dueDate: '2026-11-15',
  },
  {
    id: id(9603),
    institution: 'SVPS',
    rateId: id(9503),
    invoiceNo: 'BNX/FY2026-27/0003',
    periodStartDate: '2026-04-01',
    periodEndDate: '2027-03-31',
    studentCount: 180,
    studentCountNote: 'Counted from the admission register',
    adjustmentAmount: '-100.00',
    adjustmentNote: 'Goodwill for the late start of term',
    dueDate: '2026-05-15',
  },
  {
    id: id(9604),
    institution: 'LPS',
    rateId: id(9504),
    invoiceNo: 'BNX/FY2026-27/0004',
    periodStartDate: '2026-04-01',
    periodEndDate: '2026-09-30',
    studentCount: 250,
    studentCountNote: 'Counted from the admission register',
    adjustmentAmount: '0.00',
    adjustmentNote: null,
    dueDate: '2026-05-15',
    outcome: { paid: { date: '2026-05-12', mode: 3, reference: 'UPI 90417' } },
  },
  {
    id: id(9605),
    institution: 'LPS',
    rateId: id(9504),
    invoiceNo: 'BNX/FY2026-27/0005',
    periodStartDate: '2026-10-01',
    periodEndDate: '2027-03-31',
    studentCount: 250,
    studentCountNote: 'Counted from the admission register',
    adjustmentAmount: '0.00',
    adjustmentNote: null,
    dueDate: '2026-11-15',
  },
  {
    id: id(9606),
    institution: 'SVPS',
    rateId: id(9503),
    invoiceNo: 'BNX/FY2026-27/0006',
    periodStartDate: '2026-04-01',
    periodEndDate: '2027-03-31',
    studentCount: 180,
    studentCountNote: 'Counted from the admission register',
    adjustmentAmount: '0.00',
    adjustmentNote: null,
    dueDate: '2026-05-15',
    outcome: { cancelled: { at: '2026-04-20T09:30:00+05:30', reason: 'Raised twice by mistake' } },
  },
];

/** The financial year 2026-27 that the seeded dues are numbered in, and the first number a live due takes. */
const DEMO_INVOICE_YEAR = { key: 'FY2026-27', prefix: 'BNX/FY2026-27/', next: dues.length + 1 };

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
    select ${superAdmin.id}, 1, (
      select coalesce(max(seat_no), 0) + 1 from role_assignments where role_code = 1 and revoked_at is null
    )
    where not exists (
      select 1 from role_assignments where user_id = ${superAdmin.id} and role_code = 1 and revoked_at is null
    )
  `.execute(db);

  for (const { person: p, society: code } of owners) {
    const society = societyOf(code);
    await sql`
      insert into role_assignments (user_id, role_code, society_id, seat_no)
      select ${p.id}, 2, ${society.id}, (
        select coalesce(max(seat_no), 0) + 1 from role_assignments
        where role_code = 2 and society_id = ${society.id} and revoked_at is null
      )
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

  for (const r of rates) {
    const institution = institutionOf(r.institution);
    await sql`
      insert into institution_price_rates
        (id, society_id, institution_id, rate_per_student_amount, effective_from_date, note, created_by)
      values (${r.id}, ${societyOf(institution.society).id}, ${institution.id}, ${r.amount},
        ${r.effectiveFrom}, ${r.note}, ${superAdmin.id})
      on conflict (id) do nothing
    `.execute(db);
  }

  await insertAcademicYears(db, academicYears);
  await insertSubjects(db, subjects);
  await insertClassesOffered(db, classesOffered);

  for (const d of dues) {
    const institution = institutionOf(d.institution);
    const rate = rates.find((r) => r.id === d.rateId);
    if (!rate) throw new Error(`Unknown demo rate ${d.rateId}`);
    // The amounts raising it would give: the count times the rate, then the signed adjustment.
    const { baseAmount, totalAmount } = dueAmounts(d.studentCount, rate.amount, d.adjustmentAmount);
    const paid = d.outcome && 'paid' in d.outcome ? d.outcome.paid : undefined;
    const cancelled = d.outcome && 'cancelled' in d.outcome ? d.outcome.cancelled : undefined;
    await sql`
      insert into platform_dues
        (id, society_id, institution_id, invoice_no, period_start_date, period_end_date, student_count_auto,
         student_count, student_count_note, price_rate_id, rate_per_student_amount, base_amount, adjustment_amount,
         adjustment_note, total_amount, due_date, due_status, paid_date, payment_mode, payment_reference,
         cancelled_at, cancelled_by, cancel_reason, created_by, updated_by)
      values (${d.id}, ${societyOf(institution.society).id}, ${institution.id}, ${d.invoiceNo}, ${d.periodStartDate},
        ${d.periodEndDate}, 0, ${d.studentCount}, ${d.studentCountNote}, ${d.rateId}, ${rate.amount}, ${baseAmount},
        ${d.adjustmentAmount}, ${d.adjustmentNote}, ${totalAmount}, ${d.dueDate},
        ${paid ? DueStatus.Paid : cancelled ? DueStatus.Cancelled : DueStatus.Due},
        ${paid?.date ?? null}, ${paid?.mode ?? null}, ${paid?.reference ?? null},
        ${cancelled?.at ?? null}, ${cancelled ? superAdmin.id : null}, ${cancelled?.reason ?? null},
        ${superAdmin.id}, ${superAdmin.id})
      on conflict (id) do nothing
    `.execute(db);
  }
  // The counter continues after the seeded dues; a counter that already moved on is left alone (a counter only ever
  // steps up by one). A database seeded before the six dues (three, counter at 4) must be reset with `npm run demo:reset`,
  // not seeded again, or live raises would meet the numbers 0004 to 0006.
  await sql`
    insert into number_sequences (sequence_type, period_key, prefix, next_value)
    values (3, ${DEMO_INVOICE_YEAR.key}, ${DEMO_INVOICE_YEAR.prefix}, ${DEMO_INVOICE_YEAR.next})
    on conflict on constraint uq_number_sequences_scope do nothing
  `.execute(db);
}
