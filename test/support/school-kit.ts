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

  /** Removes the Societies made, then the people made for staff and their grants. */
  async cleanup(db: Kysely<unknown>) {
    await removeScratchSocieties(db, this.societies.splice(0));
    for (const id of this.staffUsers.splice(0)) {
      await sql`delete from role_assignments where user_id = ${id}`.execute(db);
      await sql`delete from users where id = ${id}`.execute(db);
    }
  }
}
