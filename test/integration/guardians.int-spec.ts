import { Kysely, PostgresDialect, sql } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import { writeIdentitySeed } from '../../src/seeds/identity-seed.js';
import { personaByKey } from '../../src/seeds/two-worlds.js';
import { apiCaller } from '../support/api.js';
import { superAdminToken } from '../support/admin-token.js';
import { readAuditRows } from '../support/audit-rows.js';
import { FixtureModule } from '../support/fixture.module.js';
import { clearLoginState } from '../support/login-state.js';
import { PlatformFixtures, type SignedInPerson } from '../support/platform-fixtures.js';
import { SchoolKit, type SchoolStudent, type StudentPlace } from '../support/school-kit.js';
import { signInMobile } from '../support/sessions.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
const superAdmin = personaByKey('SA1');
const TEACHER = 4;
const PARENT = 5;

interface GuardianBody {
  id: string;
  firstName: string;
  lastName: string | null;
  relation: number;
  phone: { countryCode: string; number: string };
  alternatePhone: string | null;
  email: string | null;
  occupation: string | null;
  isPrimary: boolean;
  isEmergencyContact: boolean;
  hasLogin: boolean;
  version: number;
}

const mail = () => `${newId()}@parent.test`;
const guardian = (fields: object = {}) => ({
  firstName: 'Meena',
  lastName: 'Shetty',
  relation: 2,
  phone: { countryCode: '91', number: '9845099999' },
  email: mail(),
  isPrimary: false,
  isEmergencyContact: false,
  ...fields,
});

const primaryOf = (fields: object = {}) => ({
  firstName: 'Ravi',
  lastName: 'Shetty',
  relation: 1,
  phone: { countryCode: '91', number: '9845012345' },
  email: mail(),
  isPrimary: true,
  isEmergencyContact: true,
  ...fields,
});
/** GDN-01 to GDN-04 (API design 9.6, 6.6): the guardians of a student and their parent logins. */
describe('guardians: list, add, edit and remove', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let fixtures: PlatformFixtures;
  let api: ReturnType<typeof apiCaller>;
  let kit: SchoolKit;
  let admin: string;
  let owner: SignedInPerson;
  let institutionAdmin: SignedInPerson;
  let societyId: string;
  let first: string;
  let second: string;
  let categoryId: string;
  let place: StudentPlace;
  let placeAtSecond: StudentPlace;
  let ravi: { email: string };
  let diya: SchoolStudent;

  const admit = (at: StudentPlace, fields: object = {}) =>
    kit.student(owner.token, at === placeAtSecond ? second : first, at, fields);
  const list = (student: SchoolStudent, token = owner.token) =>
    api('get', `/v1/students/${student.id}/guardians`, token);
  const listed = async (student: SchoolStudent, token = owner.token) => {
    const res = await list(student, token);
    expect(res.status).toBe(200);
    return res.body.data as unknown as GuardianBody[];
  };
  const add = (student: SchoolStudent, fields: object = guardian(), token = owner.token) =>
    api('post', `/v1/students/${student.id}/guardians`, token, fields);
  const edit = (id: string, fields: object, token = owner.token) =>
    api('patch', `/v1/guardians/${id}`, token, fields);
  const remove = (id: string, token = owner.token) => api('delete', `/v1/guardians/${id}`, token);
  const usersWith = async (address: string) =>
    (
      await sql<{ id: string; account_status: number }>`
      select id, account_status from users where email = ${address}`.execute(ownerDb)
    ).rows;
  /** Reads tenant rows as the Owner: forced row-level security hides them from the table owner too. */
  const read = <T>(
    work: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<T>,
  ) =>
    database.transaction(
      { personId: owner.person, roleCode: 2, societyId, institutionIds: [first, second] },
      work,
    );
  const links = (address: string) =>
    read(
      async (tx) =>
        (
          await sql<{ id: string; student_id: string; status: number; email: string | null }>`
            select g.id, g.student_id, g.status, g.email from student_guardians g
            join users u on u.id = g.user_id where u.email = ${address}`.execute(tx)
        ).rows,
    );
  const rowOf = (id: string) =>
    read(
      async (tx) =>
        (
          await sql<{
            user_id: string | null;
            email: string | null;
            status: number;
            is_primary: boolean;
            version: number;
            updated_by: string;
          }>`select user_id, email, status, is_primary, version, updated_by
            from student_guardians where id = ${id}`.execute(tx)
        ).rows[0]!,
    );
  const audit = async (entityId: string) =>
    (
      await readAuditRows<{
        action: string;
        entity_type: string;
        institution_id: string | null;
        old_values: Record<string, unknown> | null;
        new_values: Record<string, unknown> | null;
      }>(ownerDb, sql`entity_id = ${entityId}`)
    ).map((e) => ({
      action: e.action,
      entityType: e.entity_type,
      institutionId: e.institution_id,
      before: e.old_values,
      after: e.new_values,
    }));
  /**
   * A parent session as the app will hold one once parent contexts exist (GDN-01 "own" waits for them): a mobile
   * sign-in whose active context is role 5, which names no Society.
   */
  const parentSession = async (address: string) => {
    const login = await signInMobile(t, address);
    await sql`update auth_sessions set active_role_code = ${PARENT}, active_society_id = null
      where id = ${login.session.id}`.execute(ownerDb);
    return login.session.id;
  };
  const stillSignedIn = async (sessionId: string) =>
    (
      await sql<{
        ended_at: Date | null;
      }>`select ended_at from auth_sessions where id = ${sessionId}`.execute(ownerDb)
    ).rows[0]!.ended_at === null;

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
    categoryId = (await kit.masters(admin, 'class-categories')).find(
      (c) => c.code === 'HIGH_SCHOOL',
    )!.id;
    const classes = await kit.masters(admin, 'predefined-classes');
    const sectionCodes = await kit.masters(admin, 'predefined-sections');
    societyId = await kit.society(admin);
    owner = await fixtures.owner(societyId);
    first = await kit.institution(owner.token, categoryId);
    second = await kit.institution(owner.token, categoryId);
    institutionAdmin = await fixtures.institutionAdmin(societyId, [first]);
    const placeAt = async (institutionId: string): Promise<StudentPlace> => {
      const academicYearId = await kit.year(owner.token, institutionId);
      const classId = await kit.klass(
        owner.token,
        institutionId,
        classes.find((c) => c.code === 'C09')!.id,
      );
      const sectionId = await kit.section(
        owner.token,
        classId,
        sectionCodes.find((s) => s.code === 'A')!.id,
      );
      return { academicYearId, classId, sectionId };
    };
    place = await placeAt(first);
    placeAtSecond = await placeAt(second);
    ravi = { email: mail() };
    diya = await admit(place, {
      guardians: [primaryOf({ email: ravi.email }), guardian({ firstName: 'Meena' })],
    });
  });

  afterEach(async () => {
    await clearLoginState(ownerDb);
    await kit.cleanup(ownerDb);
    await fixtures.cleanup();
  });

  describe('GDN-01 list', () => {
    it('lists the active guardians, the primary first, with the version and whether they have a login', async () => {
      const rows = await listed(diya);
      expect(rows.map((g) => [g.firstName, g.isPrimary, g.hasLogin, g.version])).toEqual([
        ['Ravi', true, true, 1],
        ['Meena', false, true, 1],
      ]);
      expect(rows[0]).toMatchObject({
        relation: 1,
        email: ravi.email,
        phone: { countryCode: '91', number: '9845012345' },
        isEmergencyContact: true,
      });
      expect(await listed(diya, institutionAdmin.token)).toHaveLength(2);
      expect((await list(diya)).body.meta).toBeNull();
    });

    it('shows a guardian removed or without a login correctly, and still answers for a deactivated student', async () => {
      const meena = (await listed(diya))[1]!;
      await remove(meena.id);
      expect(await listed(diya)).toHaveLength(1);
      await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token);
      expect(await listed(diya)).toHaveLength(1);
    });

    it('is for Owners and Admins of the Institution: a teacher and a Super Admin are 403, strangers 404', async () => {
      const staff = await kit.staff(owner.token, first, categoryId);
      const teacher = await kit.actingAs(staff.person.email, TEACHER, societyId);
      expect((await list(diya, teacher)).status).toBe(403);
      expect((await list(diya, admin)).status).toBe(403);
      const elsewhere = await fixtures.institutionAdmin(societyId, [second]);
      expect((await list(diya, elsewhere.token)).status).toBe(404);
      const otherOwner = await fixtures.owner(await kit.society(admin));
      expect((await list(diya, otherOwner.token)).status).toBe(404);
      expect((await api('get', '/v1/students/not-a-uuid/guardians', owner.token)).status).toBe(404);
    });
  });

  describe('GDN-02 add', () => {
    it('adds a guardian with a parent login, welcomes them after the commit and audits it without the contact details', async () => {
      const body = guardian({ email: 'New.Parent@Parent.test', occupation: 'Doctor' });
      const res = await add(diya, body);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        firstName: 'Meena',
        email: 'new.parent@parent.test',
        hasLogin: true,
        isPrimary: false,
        occupation: 'Doctor',
        version: 1,
      });
      expect(await listed(diya)).toHaveLength(3);
      expect((await usersWith('new.parent@parent.test')).map((u) => u.account_status)).toEqual([3]);
      expect(t.email.latest('new.parent@parent.test', 'welcome')?.variables).toMatchObject({
        role: 'Parent',
      });
      const id = res.body.data.id as string;
      expect(await audit(id)).toEqual([
        expect.objectContaining({
          action: 'guardian.added',
          entityType: 'student_guardian',
          institutionId: first,
          after: expect.objectContaining({ studentId: diya.id, phone: '******9999' }),
        }),
      ]);
      expect(JSON.stringify(await audit(id))).not.toContain('parent.test');
      expect((await rowOf(id)).updated_by).toBe(owner.person);
    });

    it('adds a guardian without an email, with no login and no mail', async () => {
      const res = await add(diya, guardian({ email: undefined }));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ email: null, hasLogin: false });
    });

    it('links a person who already is a parent of another child: one login for both', async () => {
      const sibling = await admit(place, { guardians: [primaryOf({ email: ravi.email })] });
      expect(sibling.id).not.toBe(diya.id);
      const other = await admit(place);
      const res = await add(other, guardian({ email: ravi.email.toUpperCase() }));
      expect(res.status).toBe(201);
      expect(await usersWith(ravi.email)).toHaveLength(1);
      expect(await links(ravi.email)).toHaveLength(3);
    });

    it('is 409 ALREADY_GUARDIAN for a person who already is a guardian of this student, in any case', async () => {
      const res = await add(diya, guardian({ email: ravi.email.toUpperCase() }));
      expect([res.status, res.body.code]).toEqual([409, 'ALREADY_GUARDIAN']);
      expect(await listed(diya)).toHaveLength(2);
    });

    it('is 422 GUARDIAN_LIMIT_REACHED for a sixth guardian, and makes no account for it', async () => {
      for (let i = 0; i < 3; i += 1) expect((await add(diya)).status).toBe(201);
      const address = mail();
      const res = await add(diya, guardian({ email: address }));
      expect([res.status, res.body.code]).toEqual([422, 'GUARDIAN_LIMIT_REACHED']);
      expect(await usersWith(address)).toEqual([]);
      expect(await listed(diya)).toHaveLength(5);
    });

    it('hands the primary place to a new primary: exactly one stays', async () => {
      const res = await add(diya, guardian({ isPrimary: true }));
      expect(res.status).toBe(201);
      const rows = await listed(diya);
      expect(rows.filter((g) => g.isPrimary).map((g) => g.id)).toEqual([res.body.data.id]);
      expect(rows[0]!.id).toBe(res.body.data.id);
      const demoted = rows.find((g) => g.firstName === 'Ravi')!;
      expect(demoted).toMatchObject({ isPrimary: false, version: 2 });
      expect(await audit(demoted.id)).toContainEqual(
        expect.objectContaining({
          action: 'guardian.updated',
          before: expect.objectContaining({ isPrimary: true }),
          after: expect.objectContaining({ isPrimary: false }),
        }),
      );
    });

    it('refuses a Super Admin’s email, links a teacher’s, and adds nothing on a refusal', async () => {
      const refused = await add(diya, guardian({ email: superAdmin.email }));
      expect([refused.status, refused.body.code]).toEqual([409, 'ROLE_CONFLICT']);
      const staff = await kit.staff(owner.token, first, categoryId);
      expect((await add(diya, guardian({ email: staff.person.email }))).status).toBe(201);
      expect(await listed(diya)).toHaveLength(3);
    });

    it.each([
      ['no name', { firstName: undefined }],
      ['no relation', { relation: undefined }],
      ['no phone', { phone: undefined }],
      ['a bad email', { email: 'x' }],
      ['no isPrimary', { isPrimary: undefined }],
      ['a field of the record', { userId: newId() }],
    ])('is 400 for %s', async (_name, change) => {
      expect((await add(diya, guardian(change))).status).toBe(400);
    });

    it('is for the admins of the Institution; 404 for a deactivated student and strangers, 403 for a teacher', async () => {
      expect((await add(diya, guardian(), institutionAdmin.token)).status).toBe(201);
      const staff = await kit.staff(owner.token, first, categoryId);
      const teacher = await kit.actingAs(staff.person.email, TEACHER, societyId);
      expect((await add(diya, guardian(), teacher)).status).toBe(403);
      const elsewhere = await fixtures.institutionAdmin(societyId, [second]);
      expect((await add(diya, guardian(), elsewhere.token)).status).toBe(404);
      await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token);
      expect((await add(diya)).status).toBe(404);
    });
  });

  describe('GDN-03 edit', () => {
    it('changes the fields by version, stamps the author and audits the change', async () => {
      const meena = (await listed(diya))[1]!;
      const res = await edit(meena.id, {
        version: 1,
        firstName: 'Meenakshi',
        occupation: 'Doctor',
        relation: 4,
        phone: { countryCode: '91', number: '9845000001' },
        alternatePhone: '9845000002',
        isEmergencyContact: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        firstName: 'Meenakshi',
        occupation: 'Doctor',
        relation: 4,
        phone: { countryCode: '91', number: '9845000001' },
        alternatePhone: '9845000002',
        isEmergencyContact: true,
        version: 2,
      });
      expect((await rowOf(meena.id)).updated_by).toBe(owner.person);
      expect(await audit(meena.id)).toContainEqual(
        expect.objectContaining({
          action: 'guardian.updated',
          before: expect.objectContaining({ firstName: 'Meena', phone: '******9999' }),
          after: expect.objectContaining({ firstName: 'Meenakshi', phone: '******0001' }),
        }),
      );
      expect(JSON.stringify(await audit(meena.id))).not.toContain('9845000001');
    });

    it('clears an optional field with null, and writes nothing for a request that changes nothing', async () => {
      const meena = (await listed(diya))[1]!;
      await edit(meena.id, { version: 1, occupation: 'Doctor', alternatePhone: '9845000002' });
      const cleared = await edit(meena.id, { version: 2, occupation: null, alternatePhone: null });
      expect(cleared.body.data).toMatchObject({
        occupation: null,
        alternatePhone: null,
        version: 3,
      });
      const same = await edit(meena.id, { version: 3, firstName: 'Meena', email: meena.email });
      expect(same.status).toBe(200);
      expect(same.body.data.version).toBe(3);
      expect((await audit(meena.id)).filter((e) => e.action === 'guardian.updated')).toHaveLength(
        2,
      );
    });

    it('is 409 VERSION_CONFLICT for a stale version, before anything is changed', async () => {
      const meena = (await listed(diya))[1]!;
      await edit(meena.id, { version: 1, occupation: 'Doctor' });
      const stale = await edit(meena.id, { version: 1, occupation: 'Nurse', email: mail() });
      expect([stale.status, stale.body.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await listed(diya))[1]).toMatchObject({ occupation: 'Doctor', email: meena.email });
    });

    it('hands the primary place over with isPrimary true, and refuses to give it up', async () => {
      const [head, meena] = await listed(diya);
      const res = await edit(meena!.id, { version: 1, isPrimary: true });
      expect(res.body.data.isPrimary).toBe(true);
      const rows = await listed(diya);
      expect(rows.map((g) => [g.firstName, g.isPrimary])).toEqual([
        ['Meena', true],
        ['Ravi', false],
      ]);
      const refused = await edit(meena!.id, { version: 2, isPrimary: false });
      expect([refused.status, refused.body.code]).toEqual([422, 'PRIMARY_GUARDIAN_REQUIRED']);
      expect((await edit(head!.id, { version: 2, isPrimary: false })).status).toBe(200);
      expect((await listed(diya)).filter((g) => g.isPrimary)).toHaveLength(1);
    });

    describe('the email', () => {
      it('changes the own email of a person who holds only this link: same login, every session ended, both addresses told', async () => {
        const meena = (await listed(diya))[1]!;
        const [person] = await usersWith(meena.email!);
        const session = await parentSession(meena.email!);
        const address = mail();
        const res = await edit(meena.id, { version: 1, email: address.toUpperCase() });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ email: address, hasLogin: true, version: 2 });
        expect(await usersWith(meena.email!)).toEqual([]);
        expect((await usersWith(address)).map((u) => u.id)).toEqual([person!.id]);
        expect((await rowOf(meena.id)).user_id).toBe(person!.id);
        expect(await stillSignedIn(session)).toBe(false);
        expect(t.email.latest(meena.email!, 'email-changed-old')).toBeDefined();
        expect(t.email.latest(address, 'email-changed-new')).toBeDefined();
        const entries = await audit(meena.id);
        expect(entries).toContainEqual(
          expect.objectContaining({
            action: 'guardian.email_changed',
            institutionId: first,
            after: { emailChanged: true, outcome: 'edited', sessionsEnded: 1 },
          }),
        );
        expect(JSON.stringify(entries)).not.toContain('parent.test');
      });

      it('counts only the active links: a person whose other link was removed has their own email changed', async () => {
        const meena = (await listed(diya))[1]!;
        const [person] = await usersWith(meena.email!);
        const sibling = await admit(place);
        const other = await add(sibling, guardian({ email: meena.email }));
        expect(other.status).toBe(201);
        expect((await remove(other.body.data.id as string)).status).toBe(200);
        const address = mail();
        expect((await edit(meena.id, { version: 1, email: address })).status).toBe(200);
        expect((await usersWith(address)).map((u) => u.id)).toEqual([person!.id]);
        expect((await rowOf(meena.id)).user_id).toBe(person!.id);
        expect(await audit(meena.id)).toContainEqual(
          expect.objectContaining({
            action: 'guardian.email_changed',
            after: expect.objectContaining({ outcome: 'edited' }) as unknown,
          }),
        );
      });

      it('moves the link to the person the email belongs to, and the old person is told and keeps the account', async () => {
        const meena = (await listed(diya))[1]!;
        const target = await admit(place, { guardians: [primaryOf()] });
        const targetEmail = (await listed(target))[0]!.email!;
        const res = await edit(meena.id, { version: 1, email: targetEmail });
        expect(res.status).toBe(200);
        expect(res.body.data.email).toBe(targetEmail);
        const [targetUser] = await usersWith(targetEmail);
        expect((await rowOf(meena.id)).user_id).toBe(targetUser!.id);
        expect(await usersWith(meena.email!)).toHaveLength(1);
        expect(await links(meena.email!)).toEqual([]);
        expect(t.email.latest(meena.email!, 'guardian-access-moved')).toBeDefined();
        expect(t.email.latest(targetEmail, 'welcome')).toBeDefined();
        expect((await audit(meena.id)).at(-1)).toMatchObject({
          action: 'guardian.email_changed',
          after: expect.objectContaining({ outcome: 'moved' }),
        });
      });

      it('makes a new person for the new email when the old one holds another child, and their other child stays', async () => {
        const sibling = await admit(place, { guardians: [primaryOf({ email: ravi.email })] });
        const address = mail();
        const res = await edit((await listed(diya))[0]!.id, { version: 1, email: address });
        expect(res.status).toBe(200);
        const [old] = await usersWith(ravi.email);
        const [fresh] = await usersWith(address);
        expect(fresh!.id).not.toBe(old!.id);
        expect(fresh!.account_status).toBe(3);
        expect((await links(ravi.email)).map((l) => l.student_id)).toEqual([sibling.id]);
        expect((await links(address)).map((l) => l.student_id)).toEqual([diya.id]);
        expect(t.email.latest(address, 'welcome')).toBeDefined();
        expect((await audit((await listed(diya))[0]!.id)).at(-1)).toMatchObject({
          after: expect.objectContaining({ outcome: 'moved' }),
        });
      });

      it('leaves the old person’s sessions alone while they hold another child, and ends them for the last one', async () => {
        const sibling = await admit(place, { guardians: [primaryOf({ email: ravi.email })] });
        expect(sibling.id).toBeDefined();
        const kept = await parentSession(ravi.email);
        await edit((await listed(diya))[0]!.id, { version: 1, email: mail() });
        expect(await stillSignedIn(kept)).toBe(true);
        const meena = (await listed(diya))[1]!;
        const meenas = await parentSession(meena.email!);
        await edit(meena.id, { version: 1, email: ravi.email });
        expect(await stillSignedIn(meenas)).toBe(false);
        expect(await stillSignedIn(kept)).toBe(true);
      });

      it('makes a new person when the person holds a staff record, and never changes the teacher’s own email', async () => {
        const staff = await kit.staff(owner.token, first, categoryId);
        const asParent = await add(diya, guardian({ email: staff.person.email }));
        expect(asParent.status).toBe(201);
        const address = mail();
        const res = await edit(asParent.body.data.id as string, { version: 1, email: address });
        expect(res.status).toBe(200);
        expect((await usersWith(staff.person.email)).length).toBe(1);
        expect((await usersWith(address))[0]!.account_status).toBe(3);
      });

      it('is 409 ALREADY_GUARDIAN when the email belongs to a person who already guards this child, and changes nothing', async () => {
        const [head, meena] = await listed(diya);
        const res = await edit(meena!.id, { version: 1, email: head!.email });
        expect([res.status, res.body.code]).toEqual([409, 'ALREADY_GUARDIAN']);
        expect((await rowOf(meena!.id)).version).toBe(1);
        expect(t.email.latest(meena!.email!, 'guardian-access-moved')).toBeUndefined();
      });

      it('refuses a Super Admin’s email and one of a blocked person, and changes nothing', async () => {
        const meena = (await listed(diya))[1]!;
        const sa = await edit(meena.id, { version: 1, email: superAdmin.email });
        expect([sa.status, sa.body.code]).toEqual([409, 'ROLE_CONFLICT']);
        const [other] = await usersWith(ravi.email);
        await sql`update users set account_status = 2, blocked_at = now() where id = ${other!.id}`.execute(
          ownerDb,
        );
        const blocked = await edit(meena.id, { version: 1, email: ravi.email });
        expect([blocked.status, blocked.body.code]).toEqual([409, 'ACCOUNT_BLOCKED']);
        expect((await rowOf(meena.id)).version).toBe(1);
      });

      it('links a guardian who had no login to the person the email names, and welcomes them', async () => {
        const loginless = (await add(diya, guardian({ email: undefined }))).body
          .data as unknown as GuardianBody;
        const address = mail();
        const res = await edit(loginless.id, { version: 1, email: address });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ email: address, hasLogin: true });
        expect((await usersWith(address))[0]!.account_status).toBe(3);
        expect(t.email.latest(address, 'welcome')).toBeDefined();
        expect((await audit(loginless.id)).at(-1)).toMatchObject({
          after: expect.objectContaining({ outcome: 'linked' }),
        });
        const taken = await edit(loginless.id, { version: 2, email: null });
        expect(taken.body.data).toMatchObject({ email: null, hasLogin: false });
      });

      it('takes the login away with null: the link ends, the child leaves the person, the address is told', async () => {
        const meena = (await listed(diya))[1]!;
        const session = await parentSession(meena.email!);
        const res = await edit(meena.id, { version: 1, email: null });
        expect(res.body.data).toMatchObject({ email: null, hasLogin: false });
        expect(await links(meena.email!)).toEqual([]);
        expect(await usersWith(meena.email!)).toHaveLength(1);
        expect(await stillSignedIn(session)).toBe(false);
        expect(t.email.latest(meena.email!, 'guardian-access-removed')).toBeDefined();
        expect((await audit(meena.id)).at(-1)).toMatchObject({
          after: expect.objectContaining({ outcome: 'unlinked', personId: null }),
        });
      });

      it('lets two requests link one person to the child: one wins, the other is 409', async () => {
        const a = (await add(diya, guardian({ email: undefined }))).body
          .data as unknown as GuardianBody;
        const b = (await add(diya, guardian({ email: undefined }))).body
          .data as unknown as GuardianBody;
        const address = mail();
        const [x, y] = await Promise.all([
          edit(a.id, { version: 1, email: address }),
          edit(b.id, { version: 1, email: address }),
        ]);
        expect([x.status, y.status].toSorted()).toEqual([200, 409]);
        expect([x.body.code, y.body.code]).toContain('ALREADY_GUARDIAN');
      });
    });

    it('is for the admins of the child’s Institution; 404 for a removed guardian, a deactivated student and strangers, 403 for a teacher', async () => {
      const meena = (await listed(diya))[1]!;
      expect(
        (await edit(meena.id, { version: 1, occupation: 'A' }, institutionAdmin.token)).status,
      ).toBe(200);
      const staff = await kit.staff(owner.token, first, categoryId);
      const teacher = await kit.actingAs(staff.person.email, TEACHER, societyId);
      expect((await edit(meena.id, { version: 2, occupation: 'B' }, teacher)).status).toBe(403);
      expect((await edit(meena.id, { version: 2, occupation: 'B' }, admin)).status).toBe(403);
      const elsewhere = await fixtures.institutionAdmin(societyId, [second]);
      expect((await edit(meena.id, { version: 2, occupation: 'B' }, elsewhere.token)).status).toBe(
        404,
      );
      expect((await edit('not-a-uuid', { version: 1 })).status).toBe(404);
      expect((await edit(newId(), { version: 1 })).status).toBe(404);
      await remove(meena.id);
      expect((await edit(meena.id, { version: 3, occupation: 'C' })).status).toBe(404);
      await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token);
      expect((await edit((await rowIdsOf(diya))[0]!, { version: 1, occupation: 'D' })).status).toBe(
        404,
      );
    });

    it.each([
      ['no version', { occupation: 'A' }],
      ['a name of only spaces', { version: 1, firstName: '   ' }],
      ['a relation of 7', { version: 1, relation: 7 }],
      ['a field of the record', { version: 1, studentId: newId() }],
    ])('is 400 for %s', async (_name, body) => {
      const meena = (await listed(diya))[1]!;
      expect((await edit(meena.id, body)).status).toBe(400);
    });
  });

  const rowIdsOf = async (student: SchoolStudent) =>
    (
      await sql<{
        id: string;
      }>`select id from student_guardians where student_id = ${student.id} order by created_at, id`.execute(
        ownerDb,
      )
    ).rows.map((row) => row.id);

  describe('GDN-04 remove', () => {
    it('removes a guardian who is not the primary: the row stays inactive, the list drops it and the audit says who and why', async () => {
      const meena = (await listed(diya))[1]!;
      const res = await remove(meena.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: meena.id, status: 0 });
      expect((await listed(diya)).map((g) => g.firstName)).toEqual(['Ravi']);
      expect(await rowOf(meena.id)).toMatchObject({ status: 0, updated_by: owner.person });
      expect(await audit(meena.id)).toContainEqual(
        expect.objectContaining({
          action: 'guardian.removed',
          institutionId: first,
          before: expect.objectContaining({ studentId: diya.id, status: 1 }),
          after: expect.objectContaining({ status: 0 }),
        }),
      );
      expect(t.email.latest(meena.email!, 'guardian-access-removed')).toBeDefined();
    });

    it('is 422 for the primary and for the last guardian, and changes nothing', async () => {
      const [head, meena] = await listed(diya);
      const primary = await remove(head!.id);
      expect([primary.status, primary.body.code]).toEqual([422, 'PRIMARY_GUARDIAN_REQUIRED']);
      await remove(meena!.id);
      const last = await remove(head!.id);
      expect([last.status, last.body.code]).toEqual([422, 'LAST_GUARDIAN']);
      expect(await listed(diya)).toHaveLength(1);
    });

    it('keeps a parent who still guards another child signed in, and ends the sessions of the last link removed', async () => {
      // Ravi guards Diya (with Meena as the primary) and her sibling (with a second guardian as the primary).
      const sibling = await admit(place, { guardians: [primaryOf({ email: ravi.email })] });
      const [head, meena] = await listed(diya);
      expect((await edit(meena!.id, { version: 1, isPrimary: true })).status).toBe(200);
      const second = await add(sibling, guardian({ email: mail(), isPrimary: true }));
      expect(second.status).toBe(201);
      const session = await parentSession(ravi.email);
      const [siblingLink] = (await links(ravi.email)).filter((l) => l.student_id === sibling.id);

      // Removing the link at Diya leaves the one at the sibling: the parent stays signed in.
      expect((await remove(head!.id)).status).toBe(200);
      expect(await stillSignedIn(session)).toBe(true);
      expect((await audit(head!.id)).at(-1)?.after).toMatchObject({ sessionsEnded: 0 });

      // Removing the last link ends the parent sessions.
      expect((await remove(siblingLink!.id)).status).toBe(200);
      expect(await stillSignedIn(session)).toBe(false);
      expect((await audit(siblingLink!.id)).at(-1)?.after).toMatchObject({ sessionsEnded: 1 });
    });

    it('ends the parent sessions of a guardian who held only this child', async () => {
      const meena = (await listed(diya))[1]!;
      const lone = await parentSession(meena.email!);
      await remove(meena.id);
      expect(await stillSignedIn(lone)).toBe(false);
    });

    it('lets the person be added again later, and counts a removed guardian no more: the platform team may then take the email', async () => {
      const meena = (await listed(diya))[1]!;
      const [person] = await usersWith(meena.email!);
      const held = await sql<{
        held: boolean;
      }>`select app_is_guardian(${person!.id}::uuid) as held`.execute(ownerDb);
      expect(held.rows[0]!.held).toBe(true);
      const refused = await api('post', '/v1/platform/super-admins', admin, { email: meena.email });
      expect([refused.status, refused.body.code]).toEqual([409, 'ROLE_CONFLICT']);
      await remove(meena.id);
      const after = await sql<{
        held: boolean;
      }>`select app_is_guardian(${person!.id}::uuid) as held`.execute(ownerDb);
      expect(after.rows[0]!.held).toBe(false);
      expect(
        (await api('post', '/v1/platform/super-admins', admin, { email: meena.email })).status,
      ).toBe(201);
      await sql`delete from role_assignments where user_id = ${person!.id}`.execute(ownerDb);
      const again = await add(diya, guardian({ email: meena.email }));
      expect(again.status).toBe(201);
    });

    it('still counts a guardian of a deactivated student: the access returns with them', async () => {
      const meena = (await listed(diya))[1]!;
      const [person] = await usersWith(meena.email!);
      await api('delete', `/v1/students/${diya.id}?reason=1`, owner.token);
      const held = await sql<{
        held: boolean;
      }>`select app_is_guardian(${person!.id}::uuid) as held`.execute(ownerDb);
      expect(held.rows[0]!.held).toBe(true);
      expect((await remove(meena.id)).status).toBe(404);
    });

    it('is for the admins of the child’s Institution: 404 for strangers and a removed guardian, 403 for a teacher', async () => {
      const [, meena] = await listed(diya);
      const staff = await kit.staff(owner.token, first, categoryId);
      const teacher = await kit.actingAs(staff.person.email, TEACHER, societyId);
      expect((await remove(meena!.id, teacher)).status).toBe(403);
      expect((await remove(meena!.id, admin)).status).toBe(403);
      const elsewhere = await fixtures.institutionAdmin(societyId, [second]);
      expect((await remove(meena!.id, elsewhere.token)).status).toBe(404);
      expect((await remove('not-a-uuid')).status).toBe(404);
      expect((await remove(meena!.id, institutionAdmin.token)).status).toBe(200);
      expect((await remove(meena!.id)).status).toBe(404);
    });
  });

  it('keeps tenants apart: a guardian of the other Institution cannot be read or changed', async () => {
    const abroad = await admit(placeAtSecond);
    const [row] = await listed(abroad);
    expect(
      (await edit(row!.id, { version: 1, occupation: 'A' }, institutionAdmin.token)).status,
    ).toBe(404);
    expect((await remove(row!.id, institutionAdmin.token)).status).toBe(404);
    expect((await list(abroad, institutionAdmin.token)).status).toBe(404);
    const seen = await database.transaction(
      { personId: owner.person, roleCode: 2, societyId, institutionIds: [first] },
      async (tx) => (await sql`select id from student_guardians`.execute(tx)).rows.length,
    );
    expect(seen).toBe(2);
  });

  describe('app_guardian_link_count', () => {
    it('counts the active links of a person in any Society, and puts the caller’s settings back', async () => {
      const [person] = await usersWith(ravi.email);
      const settings = sql<{ role: string; person: string }>`
        select current_setting('app.role_code', true) as role,
          current_setting('app.person_id', true) as person`;
      const asked = (tenant: Parameters<DatabaseService['transaction']>[0]) =>
        database.transaction(tenant, async (tx) => {
          const before = (await settings.execute(tx)).rows[0];
          const count = (
            await sql<{
              n: number;
            }>`select app_guardian_link_count(${person!.id}::uuid) as n`.execute(tx)
          ).rows[0]!.n;
          return { count, back: (await settings.execute(tx)).rows[0], before };
        });
      const otherSociety = await kit.society(admin);
      const own = await asked({
        personId: owner.person,
        roleCode: 2,
        societyId,
        institutionIds: [first],
      });
      expect(own.count).toBe(1);
      expect(own.back).toEqual(own.before);
      // Another Society's tenant counts the same links, and the caller's settings are still put back.
      const abroad = await asked({
        personId: owner.person,
        roleCode: 2,
        societyId: otherSociety,
        institutionIds: [],
      });
      expect(abroad.count).toBe(1);
      expect(abroad.back).toEqual(abroad.before);
    });
  });
});
