import { Kysely, PostgresDialect, sql } from 'kysely';
import request from 'supertest';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import * as blocks from '../support/blocks.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import {
  SchoolKit,
  succeeded,
  type SchoolStudent,
  type StudentPlace,
} from '../support/school-kit.js';
import { signInMobile, type LoginContext } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const PARENT = 5;

interface ChildBody {
  studentId: string;
  firstName: string;
  institutionId: string;
  institutionName: string;
  societyId: string;
  className: string | null;
  sectionName: string | null;
  isBlocked: boolean;
}

const mail = () => `${Math.random().toString(36).slice(2)}@parent.test`;

/** The Student / Parent context (API design 6.3, 6.4, 6.5): one context for the person, their children, and what a parent may read. */
describe('the parent signs in and reads their own child', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;
  let owner: SignedInPerson;
  let societyId: string;
  let institution: string;
  let place: StudentPlace;
  let diya: SchoolStudent;
  let arjun: SchoolStudent;
  let stranger: SchoolStudent;
  let ravi: string;
  let meena: string;

  /** Signs the parent in and chooses their one context; returns the token that acts in it. */
  const asParent = async (email: string) => {
    const login = await signInMobile(t, email);
    if (login.session.activeContext) return login.accessToken;
    const chosen = await api('post', '/v1/auth/context', login.accessToken, { roleCode: PARENT });
    succeeded(chosen, 200, 'parent context');
    return chosen.body.data.accessToken as string;
  };
  const me = async (token: string) =>
    (await api('get', '/v1/me', token)).body.data as unknown as {
      contexts: (LoginContext & { children?: ChildBody[] })[];
      session: { activeContext: (LoginContext & { children?: ChildBody[] }) | null };
    };
  const guardians = (student: SchoolStudent, token: string) =>
    api('get', `/v1/students/${student.id}/guardians`, token);
  const stars = (student: SchoolStudent, token: string) =>
    api('get', `/v1/students/${student.id}/achievements`, token);
  // The person is not a guardian of anyone, so only the policies for the named child can match.
  const parentTenant = (childIds: string[], roleCode = PARENT) => ({
    personId: owner.person,
    roleCode,
    childIds,
  });
  const readAs = <T>(
    tenant: Parameters<DatabaseService['transaction']>[0],
    work: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<T>,
  ) => database.transaction(tenant, work);

  /** A new Society with an Owner, an Institution and a section to place students in. */
  const makeSchool = async () => {
    const categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    const classes = await kit.masters(admin, 'predefined-classes');
    const sectionCodes = await kit.masters(admin, 'predefined-sections');
    const society = await kit.society(admin);
    const schoolOwner = await fixtures.owner(society);
    const institutionId = await kit.institution(schoolOwner.token, categoryId);
    const academicYearId = await kit.year(schoolOwner.token, institutionId);
    const classId = await kit.klass(
      schoolOwner.token,
      institutionId,
      classes.find((c) => c.code === 'C09')!.id,
    );
    const sectionId = await kit.section(
      schoolOwner.token,
      classId,
      sectionCodes.find((c) => c.code === 'A')!.id,
    );
    return {
      societyId: society,
      owner: schoolOwner,
      institution: institutionId,
      place: { academicYearId, classId, sectionId },
    };
  };

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await writeIdentitySeed(ownerDb);
    t = await createTestApp({ imports: [FixtureModule] });
    database = t.app.get(DatabaseService);
    fixtures = new PlatformFixtures(t, ownerDb);
    api = apiCaller(t);
    kit = new SchoolKit(t, api);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await clearLoginState(ownerDb);
    admin = await superAdminToken(t, ownerDb, superAdmin.id);
    const school = await makeSchool();
    societyId = school.societyId;
    owner = school.owner;
    institution = school.institution;
    place = school.place;
    ravi = mail();
    meena = '';
    diya = await kit.student(owner.token, institution, place, {
      firstName: 'Diya',
      guardians: [
        {
          firstName: 'Ravi',
          relation: 1,
          phone: { countryCode: '91', number: '9845012345' },
          email: ravi,
          isPrimary: true,
          isEmergencyContact: true,
        },
      ],
    });
    // Ravi's second child, and a child of nobody he knows.
    arjun = await kit.student(owner.token, institution, place, {
      firstName: 'Arjun',
      guardians: [
        {
          firstName: 'Ravi',
          relation: 1,
          phone: { countryCode: '91', number: '9845012345' },
          email: ravi,
          isPrimary: true,
          isEmergencyContact: true,
        },
      ],
    });
    stranger = await kit.student(owner.token, institution, place, { firstName: 'Kiran' });
    meena = await readAs(
      { personId: owner.person, roleCode: 2, societyId, institutionIds: [institution] },
      async (tx) =>
        (
          await sql<{ user_id: string }>`
            select user_id from student_guardians where student_id = ${diya.id} and user_id is not null
          `.execute(tx)
        ).rows[0]!.user_id,
    );
  });

  afterEach(async () => {
    await blocks.clearBlocks(ownerDb);
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('sign-in and ME-01', () => {
    it('lists one Parent context with no Society, holding every child, and starts the session in it', async () => {
      const login = await signInMobile(t, ravi);
      expect(login.contexts).toHaveLength(1);
      expect(login.contexts[0]).toMatchObject({
        roleCode: PARENT,
        societyId: null,
        societyName: null,
        isBlocked: false,
      });
      expect(login.session.activeContext).toMatchObject({ roleCode: PARENT });
      expect(login.userType).toBe(PARENT);
      const children = (login.contexts[0] as LoginContext & { children: ChildBody[] }).children;
      expect(children.map((c) => c.firstName).toSorted()).toEqual(['Arjun', 'Diya']);
      expect(children.find((c) => c.firstName === 'Diya')).toMatchObject({
        studentId: diya.id,
        institutionId: institution,
        societyId,
        className: expect.any(String),
        sectionName: 'A',
        isBlocked: false,
      });
    });

    it('answers ME-01 with the same children, and lets AUTH-06 choose the context without a Society', async () => {
      const token = await asParent(ravi);
      const profile = await me(token);
      expect(profile.session.activeContext?.roleCode).toBe(PARENT);
      expect(profile.contexts[0]?.children).toHaveLength(2);
      const refused = await api('post', '/v1/auth/context', token, {
        roleCode: PARENT,
        societyId,
      });
      expect(refused.status).toBe(400);
    });

    it('keeps a person who is a guardian and an Owner at two contexts, and lists no Parent context for a person who guards nobody', async () => {
      const ownerGuardian = await kit.student(owner.token, institution, place, {
        firstName: 'Owner child',
        guardians: [
          {
            firstName: 'Own',
            relation: 1,
            phone: { countryCode: '91', number: '9845012346' },
            email: owner.email,
            isPrimary: true,
            isEmergencyContact: true,
          },
        ],
      });
      expect(ownerGuardian.guardians[0]?.hasLogin).toBe(true);
      const login = await signInMobile(t, owner.email);
      expect(login.contexts.map((c) => c.roleCode).toSorted()).toEqual([2, PARENT]);
      expect(login.session.activeContext).toBeNull();
      const none = await signInMobile(
        t,
        (await fixtures.institutionAdmin(societyId, [institution])).email,
      );
      expect(none.contexts.map((c) => c.roleCode)).toEqual([3]);
    });

    it('makes one context of children in two Societies, and reads each child under its own Society', async () => {
      const other = await makeSchool();
      const abroad = await kit.student(other.owner.token, other.institution, other.place, {
        firstName: 'Asha',
        guardians: [
          {
            firstName: 'Ravi',
            relation: 1,
            phone: { countryCode: '91', number: '9845012345' },
            email: ravi,
            isPrimary: true,
            isEmergencyContact: true,
          },
        ],
      });
      const token = await asParent(ravi);
      const context = (await me(token)).session.activeContext;
      expect(context?.children?.map((c) => [c.firstName, c.societyId]).toSorted()).toEqual(
        [
          ['Arjun', societyId],
          ['Asha', other.societyId],
          ['Diya', societyId],
        ].toSorted(),
      );
      expect((await guardians(abroad, token)).status).toBe(200);
      expect((await guardians(diya, token)).status).toBe(200);
      // Blocking the students of one Society's Institution stops only its children.
      await blocks.setBlock(ownerDb, other.societyId, other.institution, 3, true);
      expect((await guardians(abroad, token)).status).toBe(423);
      expect((await guardians(diya, token)).status).toBe(200);
      expect((await me(token)).session.activeContext?.isBlocked).toBe(false);
    });

    it('leaves a deactivated child out, and a blocked child in with isBlocked', async () => {
      succeeded(
        await api('delete', `/v1/students/${arjun.id}?reason=1`, owner.token),
        200,
        'deactivate',
      );
      succeeded(await api('post', `/v1/students/${diya.id}/block`, owner.token, {}), 200, 'block');
      const token = await asParent(ravi);
      const context = (await me(token)).session.activeContext;
      expect(context?.children?.map((c) => [c.firstName, c.isBlocked])).toEqual([['Diya', true]]);
      // Every child blocked: the context is blocked and can still be chosen; its data answers per child.
      expect(context?.isBlocked).toBe(true);
    });
  });

  describe('own children only', () => {
    it('reads the guardians and the stars of their own child', async () => {
      succeeded(
        await api('post', `/v1/students/${diya.id}/achievements`, owner.token, {
          tier: 2,
          description: 'Quiz winner',
        }),
        201,
        'star',
      );
      const token = await asParent(ravi);
      const list = await guardians(diya, token);
      expect(list.status).toBe(200);
      expect(
        (list.body.data as unknown as { firstName: string }[]).map((g) => g.firstName),
      ).toEqual(['Ravi']);
      const total = async (student: SchoolStudent) => {
        const tab = await stars(student, token);
        expect(tab.status).toBe(200);
        return (tab.body.data as unknown as { stars: { total: number } }).stars.total;
      };
      expect(await total(diya)).toBe(1);
      expect(await total(arjun)).toBe(0);
    });

    it('answers 404 for a child who is not theirs, in the same Institution or another Society', async () => {
      const token = await asParent(ravi);
      expect((await guardians(stranger, token)).status).toBe(404);
      expect((await stars(stranger, token)).status).toBe(404);
      const otherSociety = await kit.society(admin);
      const otherOwner = await fixtures.owner(otherSociety);
      expect((await guardians(diya, otherOwner.token)).status).toBe(404);
      expect((await api('get', '/v1/students/not-a-uuid/guardians', token)).status).toBe(404);
    });

    it('opens no endpoint that is not theirs: the profile, a star given and the lists are 403', async () => {
      const token = await asParent(ravi);
      expect((await api('get', `/v1/students/${diya.id}`, token)).status).toBe(403);
      expect((await api('get', '/v1/students', token)).status).toBe(403);
      expect(
        (
          await api('post', `/v1/students/${diya.id}/achievements`, token, {
            tier: 1,
            description: 'Mine',
          })
        ).status,
      ).toBe(403);
    });

    it('stops reading a child on the next call once the link ends, and keeps the sibling', async () => {
      const token = await asParent(ravi);
      expect((await guardians(diya, token)).status).toBe(200);
      const link = diya.guardians.find((g) => g.hasLogin)!;
      // A student keeps one guardian at least, and the primary: hand both over before the link goes.
      succeeded(
        await api('post', `/v1/students/${diya.id}/guardians`, owner.token, {
          firstName: 'Meena',
          relation: 2,
          phone: { countryCode: '91', number: '9845012399' },
          isPrimary: true,
          isEmergencyContact: false,
        }),
        201,
        'second guardian',
      );
      succeeded(await api('delete', `/v1/guardians/${link.id}`, owner.token), 200, 'remove');
      expect((await guardians(diya, token)).status).toBe(404);
      expect((await guardians(arjun, token)).status).toBe(200);
    });
  });

  describe('blocks', () => {
    it('answers 403 CHILD_ACCESS_BLOCKED for a blocked child only, and the sibling keeps working; lifting restores it', async () => {
      const token = await asParent(ravi);
      succeeded(await api('post', `/v1/students/${diya.id}/block`, owner.token, {}), 200, 'block');
      const refused = await guardians(diya, token);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('CHILD_ACCESS_BLOCKED');
      expect((await stars(diya, token)).status).toBe(403);
      expect((await guardians(arjun, token)).status).toBe(200);
      const profile = await me(token);
      expect(profile.session.activeContext?.isBlocked).toBe(false);
      expect(
        profile.session.activeContext?.children?.map((c) => [c.firstName, c.isBlocked]),
      ).toEqual(
        expect.arrayContaining([
          ['Diya', true],
          ['Arjun', false],
        ]),
      );
      succeeded(await api('post', `/v1/students/${diya.id}/unblock`, owner.token, {}), 200, 'lift');
      expect((await guardians(diya, token)).status).toBe(200);
    });

    it('answers 423 SECTION_BLOCKED (students) for every child of a blocked Institution, and the owners keep working', async () => {
      const token = await asParent(ravi);
      await blocks.setBlock(ownerDb, societyId, institution, 3, true);
      const refused = await guardians(diya, token);
      expect(refused.status).toBe(423);
      expect(refused.body.code).toBe('SECTION_BLOCKED');
      expect(refused.body.data).toMatchObject({ section: 'students' });
      expect((await me(token)).session.activeContext?.isBlocked).toBe(true);
      expect((await guardians(diya, owner.token)).status).toBe(200);
      await blocks.setBlock(ownerDb, societyId, institution, 3, false);
      expect((await guardians(diya, token)).status).toBe(200);
    });
  });

  describe('row-level security', () => {
    it('shows a parent request only the rows of the child it names, in every table that holds a child', async () => {
      succeeded(
        await api('post', `/v1/students/${diya.id}/achievements`, owner.token, {
          tier: 1,
          description: 'Quiz',
        }),
        201,
        'star',
      );
      succeeded(
        await api('post', `/v1/students/${stranger.id}/achievements`, owner.token, {
          tier: 1,
          description: 'Quiz',
        }),
        201,
        'star',
      );
      const counts = await readAs(parentTenant([diya.id]), async (tx) => ({
        students: (await sql<{ id: string }>`select id from students`.execute(tx)).rows.map(
          (r) => r.id,
        ),
        guardians: (
          await sql<{ n: number }>`select count(*)::int as n from student_guardians`.execute(tx)
        ).rows[0]!.n,
        enrolments: (
          await sql<{ n: number }>`select count(*)::int as n from student_enrolments`.execute(tx)
        ).rows[0]!.n,
        placements: (
          await sql<{
            n: number;
          }>`select count(*)::int as n from student_section_placements`.execute(tx)
        ).rows[0]!.n,
        achievements: (
          await sql<{ n: number }>`select count(*)::int as n from student_achievements`.execute(tx)
        ).rows[0]!.n,
      }));
      expect(counts).toEqual({
        students: [diya.id],
        guardians: 1,
        enrolments: 1,
        placements: 1,
        achievements: 1,
      });
    });

    it('shows nothing without a child set, to a role that is not a parent, and for a child that is not named', async () => {
      const every = async (tenant: Parameters<DatabaseService['transaction']>[0]) =>
        readAs(tenant, async (tx) => [
          (await sql<{ n: number }>`select count(*)::int as n from students`.execute(tx)).rows[0]!
            .n,
          (await sql<{ n: number }>`select count(*)::int as n from student_guardians`.execute(tx))
            .rows[0]!.n,
          (await sql<{ n: number }>`select count(*)::int as n from student_enrolments`.execute(tx))
            .rows[0]!.n,
        ]);
      expect(await every(parentTenant([]))).toEqual([0, 0, 0]);
      // The setting widens nothing for any role but 5.
      expect(await every(parentTenant([diya.id], 4))).toEqual([0, 0, 0]);
      expect(await every({ personId: owner.person, roleCode: 5 })).toEqual([0, 0, 0]);
      expect(
        await readAs(parentTenant([stranger.id]), async (tx) =>
          (await sql<{ id: string }>`select id from students`.execute(tx)).rows.map((r) => r.id),
        ),
      ).toEqual([stranger.id]);
    });

    it('gives a parent no write on any of them', async () => {
      await expect(
        readAs(parentTenant([diya.id]), (tx) =>
          sql`update students set first_name = 'Changed' where id = ${diya.id}`.execute(tx),
        ),
      ).resolves.toMatchObject({ numAffectedRows: 0n });
      await expect(
        readAs(parentTenant([diya.id]), (tx) =>
          sql`update student_guardians set first_name = 'Changed' where student_id = ${diya.id}`.execute(
            tx,
          ),
        ),
      ).resolves.toMatchObject({ numAffectedRows: 0n });
    });

    it('returns a person’s children whoever calls the function, and puts the caller’s settings back', async () => {
      const result = await readAs(
        { personId: owner.person, roleCode: 2, societyId },
        async (tx) => {
          const children = await sql<{ student_id: string }>`
          select student_id from app_children(${meena}::uuid)
        `.execute(tx);
          const after = await sql<{ role: string; person: string }>`
          select current_setting('app.role_code') as role, current_setting('app.person_id') as person
        `.execute(tx);
          return {
            children: children.rows.map((r) => r.student_id).toSorted(),
            after: after.rows[0]!,
          };
        },
      );
      expect(result.children).toEqual([arjun.id, diya.id].toSorted());
      expect(result.after).toEqual({ role: '2', person: owner.person });
    });

    it('returns nothing for a person who guards nobody', async () => {
      const none = await readAs(
        { personId: owner.person, roleCode: 2, societyId },
        async (tx) =>
          (await sql`select * from app_children(${owner.person}::uuid)`.execute(tx)).rows,
      );
      expect(none).toEqual([]);
    });
  });

  it('is unreachable without a token', async () => {
    const res = await request(t.app.getHttpServer()).get(`/v1/students/${diya.id}/guardians`);
    expect(res.status).toBe(401);
  });
});
