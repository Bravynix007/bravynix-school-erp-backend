import { sql, type Kysely } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import type { apiCaller } from './api.js';
import { removeScratchSocieties } from './scratch-society.js';
import { signInMobile } from './sessions.js';
import type { TestApp } from './test-app.js';

/** The answer of a call that must have worked: a test that cannot set itself up fails here, with the reason. */
export function succeeded<T extends { status: number }>(res: T, expected: number, what: string): T {
  if (res.status !== expected) {
    throw new Error(`${what}: expected ${expected}, got ${res.status} ${JSON.stringify(res)}`);
  }
  return res;
}

export interface Entry {
  id: string;
  code: string;
}

/** A staff member as STF-02 answers; enough to find them and sign in as them. */
export interface SchoolStaff {
  id: string;
  person: { id: string; email: string };
}

/** A student as STU-02 answers; enough to find them and see where they sit. */
export interface SchoolStudent {
  id: string;
  institutionId: string;
  admissionNo: string | null;
  firstName: string;
  version: number;
  placement: { academicYearId: string; classId: string; sectionId: string; rollNumber: string };
  guardians: { id: string; email: string | null; hasLogin: boolean; isPrimary: boolean }[];
}

/** Where a new student sits, and what the body needs besides. */
export interface StudentPlace {
  academicYearId: string;
  classId: string;
  sectionId: string;
}

/**
 * Builds the school a test needs through the API: a Society, its Institutions, years, classes, sections, subjects and
 * staff, all as the token it is given. Everything made is removed by `cleanup`.
 */
export class SchoolKit {
  private readonly societies: string[] = [];
  private readonly staffUsers: string[] = [];

  constructor(
    private readonly t: TestApp,
    private readonly api: ReturnType<typeof apiCaller>,
  ) {}

  async masters(token: string, type: string) {
    return (await this.api('get', `/v1/masters/${type}`, token)).body.data as unknown as Entry[];
  }

  async society(adminToken: string) {
    const res = await this.api('post', '/v1/platform/societies', adminToken, {
      name: 'Sunrise Trust',
      code: `S${newId().slice(-12)}`,
    });
    this.societies.push(res.body.data.id);
    return res.body.data.id as string;
  }

  async institution(token: string, categoryId: string) {
    const res = await this.api('post', '/v1/institutions', token, {
      name: 'Green Valley School',
      code: `I${newId().slice(-10)}`,
      address: { line1: '12 Lake Road' },
      classesOffered: [categoryId],
    });
    succeeded(res, 201, 'institution');
    return res.body.data.id as string;
  }

  async year(token: string, institutionId: string, fields: object = {}) {
    const res = await this.api('post', '/v1/academic-years', token, {
      institutionId,
      name: '2026-2027',
      startDate: '2026-06-01',
      endDate: '2027-03-31',
      ...fields,
    });
    succeeded(res, 201, 'academic year');
    return res.body.data.id as string;
  }

  async klass(token: string, institutionId: string, predefinedClassId: string) {
    const res = await this.api('post', '/v1/classes', token, { institutionId, predefinedClassId });
    succeeded(res, 201, 'class');
    return res.body.data.id as string;
  }

  async section(token: string, classId: string, predefinedSectionId: string) {
    const res = await this.api('post', '/v1/sections', token, { classId, predefinedSectionId });
    succeeded(res, 201, 'section');
    return res.body.data.id as string;
  }

  async subject(token: string, name = `Subject ${newId().slice(-6)}`) {
    const res = await this.api('post', '/v1/subjects', token, { name });
    succeeded(res, 201, 'subject');
    return res.body.data.id as string;
  }

  async staff(token: string, homeInstitutionId: string, categoryId: string, fields: object = {}) {
    const res = await this.api('post', '/v1/staff', token, {
      homeInstitutionId,
      email: `${newId()}@staff.test`,
      firstName: 'Meera',
      classCategoryId: categoryId,
      mobile: { countryCode: '91', number: '9876500001' },
      ...fields,
    });
    succeeded(res, 201, 'staff member');
    const staff = res.body.data as unknown as SchoolStaff;
    this.staffUsers.push(staff.person.id);
    return staff;
  }

  /** The body of STU-02 for a student placed in `place`, with one primary guardian; `fields` replace its parts. */
  studentBody(institutionId: string, place: StudentPlace, fields: object = {}) {
    return {
      institutionId,
      firstName: 'Diya',
      lastName: 'Shetty',
      mobile: { countryCode: '91', number: '9876501234' },
      enrolment: { ...place, rollNumber: `R${newId().slice(-8)}` },
      guardians: [
        {
          firstName: 'Ravi',
          lastName: 'Shetty',
          relation: 1,
          phone: { countryCode: '91', number: '9845012345' },
          email: `${newId()}@parent.test`,
          isPrimary: true,
          isEmergencyContact: true,
        },
      ],
      ...fields,
    };
  }

  /** Adds a student through STU-02 as `token`. */
  async student(token: string, institutionId: string, place: StudentPlace, fields: object = {}) {
    const body = this.studentBody(institutionId, place, fields);
    const res = succeeded(await this.api('post', '/v1/students', token, body), 201, 'student');
    return res.body.data as unknown as SchoolStudent;
  }

  /** Signs the person in (from `ip`, when sign-ins must not share an address) and chooses the context; returns the token that acts in it. */
  async actingAs(email: string, roleCode: number, societyId: string, ip?: string) {
    const login = await signInMobile(this.t, email, ip);
    const chosen = await this.api('post', '/v1/auth/context', login.accessToken, {
      roleCode,
      societyId,
    });
    succeeded(chosen, 200, 'context');
    return chosen.body.data.accessToken as string;
  }

  /** Removes the Societies made, then the people made for staff and as parents, and their grants. */
  async cleanup(db: Kysely<unknown>) {
    await removeScratchSocieties(db, this.societies.splice(0));
    // The parents' logins the students made, which `studentBody` gives this domain; their guardian rows went above.
    await sql`delete from users where email like '%@parent.test'`.execute(db);
    for (const id of this.staffUsers.splice(0)) {
      await sql`delete from role_assignments where user_id = ${id}`.execute(db);
      await sql`delete from users where id = ${id}`.execute(db);
    }
  }
}
