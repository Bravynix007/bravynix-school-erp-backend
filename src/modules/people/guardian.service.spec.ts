import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { AccountDirectory, GuardianEmailChange } from '../../platform/identity/index.js';
import type { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import { GuardianContext } from './guardian-context.js';
import type { UpdateGuardianDto } from './guardian.dto.js';
import type { GuardianRepository } from './guardian.repository.js';
import { GuardianService } from './guardian.service.js';
import { StudentContext } from './student-context.js';
import type { GuardianDto } from './student.dto.js';
import type { GuardianRow, StudentRepository, StudentRow } from './student.repository.js';

const admin = { personId: 'admin-1', roleCode: 3, societyId: 'society-1' } as unknown as Principal;
const NOW = '2026-11-12T04:30:00.000Z';

const unique = (constraint: string) =>
  Object.assign(new Error('unique'), { code: '23505', constraint });

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

const student = (overrides: Partial<StudentRow> = {}): StudentRow =>
  ({
    id: 'student-1',
    society_id: 'society-1',
    institution_id: 'institution-1',
    status: 1,
    ...overrides,
  }) as StudentRow;

const guardian = (overrides: Partial<GuardianRow> = {}): GuardianRow =>
  ({
    id: 'guardian-1',
    version: 2,
    status: 1,
    society_id: 'society-1',
    institution_id: 'institution-1',
    student_id: 'student-1',
    user_id: 'user-1',
    first_name: 'Ravi',
    last_name: 'Shetty',
    relation: 1,
    country_code: '91',
    phone_number: '9845012345',
    alternate_phone: null,
    email: 'ravi@example.com',
    occupation: null,
    is_primary: false,
    is_emergency_contact: false,
    ...overrides,
  }) as GuardianRow;

const primary = guardian({
  id: 'guardian-0',
  user_id: 'user-0',
  email: 'asha@example.com',
  is_primary: true,
});
const person = (id: string, email: string, created = false) => ({
  id,
  email,
  displayName: email,
  created,
});

const newGuardian = (overrides: Partial<GuardianDto> = {}): GuardianDto =>
  ({
    firstName: 'Meena',
    lastName: 'Shetty',
    relation: 2,
    phone: { countryCode: '91', number: '9845099999' },
    email: 'Meena@Example.com',
    isPrimary: false,
    isEmergencyContact: false,
    ...overrides,
  }) as GuardianDto;

function build(
  options: {
    guardians?: GuardianRow[];
    current?: GuardianRow | undefined;
    student?: StudentRow | undefined;
  } = {},
) {
  const tx = {} as Tx;
  const order: string[] = [];
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const stored = options.guardians ?? [primary, guardian()];
  const findStudent = vi
    .fn<StudentRepository['find']>()
    .mockResolvedValue('student' in options ? options.student : student());
  const list = vi.fn<StudentRepository['guardians']>().mockResolvedValue(stored);
  const insertGuardians = vi
    .fn<StudentRepository['insertGuardians']>()
    .mockImplementation((_tx, rows) =>
      Promise.resolve(
        rows.map(
          (values) => ({ id: 'guardian-new', version: 1, status: 1, ...values }) as GuardianRow,
        ),
      ),
    );
  const findGuardian = vi
    .fn<GuardianRepository['find']>()
    .mockResolvedValue('current' in options ? options.current : guardian());
  const update = vi.fn<GuardianRepository['update']>().mockImplementation((_tx, id, changes) => {
    order.push(`update:${id}`);
    const base = id === primary.id ? primary : guardian();
    return Promise.resolve({ ...base, ...changes, version: base.version + 1 } as GuardianRow);
  });
  const primaryOf = vi.fn<GuardianRepository['primaryOf']>().mockResolvedValue(primary);
  const isLinked = vi.fn<GuardianRepository['isLinked']>().mockResolvedValue(false);
  const linkGuardian = vi
    .fn<AccountDirectory['linkGuardian']>()
    .mockImplementation((_tx, p) =>
      Promise.resolve(person('user-new', p.email.toLowerCase(), true)),
    );
  const changeGuardianEmail = vi.fn<AccountDirectory['changeGuardianEmail']>();
  const endParentSessionsIfLast = vi
    .fn<AccountDirectory['endParentSessionsIfLast']>()
    .mockResolvedValue(2);
  const welcomeAs = vi.fn<AccountDirectory['welcomeAs']>(() => {
    order.push('welcome');
  });
  const announceGuardianEmail = vi.fn<AccountDirectory['announceGuardianEmail']>();
  const announceGuardianRemoved = vi.fn<AccountDirectory['announceGuardianRemoved']>();
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue({
    institutionId: 'institution-1',
    societyId: 'society-1',
    tenant: { societyId: 'society-1', institutionIds: ['institution-1'] },
  });
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant: { societyId: 'society-1' } } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const database = { transaction } as unknown as DatabaseService;
  const students = {
    find: findStudent,
    guardians: list,
    insertGuardians,
  } as unknown as StudentRepository;
  const guardians = {
    find: findGuardian,
    update,
    primaryOf,
    isLinked,
  } as unknown as GuardianRepository;
  const scope = { requireInstitution, forPrincipal } as unknown as ScopeService;
  const service = new GuardianService(
    database,
    students,
    guardians,
    new StudentContext(database, students, scope),
    new GuardianContext(database, guardians, scope),
    {
      linkGuardian,
      changeGuardianEmail,
      endParentSessionsIfLast,
      welcomeAs,
      announceGuardianEmail,
      announceGuardianRemoved,
    } as unknown as AccountDirectory,
    {
      names: vi.fn<InstitutionDirectory['names']>().mockResolvedValue(
        new Map([
          [
            'institution-1',
            {
              id: 'institution-1',
              name: 'School',
              societyId: 'society-1',
              societyName: 'Sunrise Trust',
            },
          ],
        ]),
      ),
    } as unknown as InstitutionDirectory,
    { record } as unknown as AuditService,
    new FixedClock(NOW),
  );
  return {
    service,
    order,
    transaction,
    findStudent,
    list,
    insertGuardians,
    findGuardian,
    update,
    primaryOf,
    isLinked,
    linkGuardian,
    changeGuardianEmail,
    endParentSessionsIfLast,
    welcomeAs,
    announceGuardianEmail,
    announceGuardianRemoved,
    record,
    requireInstitution,
    forPrincipal,
  };
}

const edit = (fields: Partial<UpdateGuardianDto> = {}): UpdateGuardianDto =>
  ({ version: 2, ...fields }) as UpdateGuardianDto;

const changeOf = (
  kind: 'edited' | 'moved' | 'unchanged',
  who = person('user-1', 'new@example.com'),
): GuardianEmailChange =>
  kind === 'unchanged'
    ? { kind, person: who }
    : {
        kind,
        person: who,
        previousEmail: 'ravi@example.com',
        sessionsEnded: kind === 'edited' ? 3 : 1,
      };

describe('GuardianService.list (GDN-01)', () => {
  it('opens the Institution of the student and lists the active guardians, the primary first, with their versions', async () => {
    const t = build();
    const listed = await t.service.list(admin, 'student-1');
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'institution-1');
    expect(listed.map((g) => [g.id, g.isPrimary, g.version])).toEqual([
      ['guardian-0', true, 2],
      ['guardian-1', false, 2],
    ]);
    expect(listed[0]).toMatchObject({
      hasLogin: true,
      phone: { countryCode: '91', number: '9845012345' },
    });
  });

  it('is 404 for a student the caller does not reach', async () => {
    const t = build({ student: undefined });
    expect((await refusal(t.service.list(admin, 'student-1'))).status).toBe(404);
  });
});

describe('GuardianService.add (GDN-02)', () => {
  it('links the person by email, adds the guardian with the stamps, audits it and welcomes the person after the commit', async () => {
    const t = build();
    const result = await t.service.add(admin, 'student-1', newGuardian());
    expect(t.linkGuardian).toHaveBeenCalledWith(
      expect.anything(),
      { email: 'Meena@Example.com', firstName: 'Meena', lastName: 'Shetty' },
      'admin-1',
    );
    expect(t.insertGuardians.mock.calls[0]![1]).toEqual([
      expect.objectContaining({
        society_id: 'society-1',
        institution_id: 'institution-1',
        created_by: 'admin-1',
        student_id: 'student-1',
        user_id: 'user-new',
        email: 'meena@example.com',
        is_primary: false,
      }),
    ]);
    expect(result.options).toMatchObject({ status: 201, code: 'CREATED' });
    expect(result.data).toMatchObject({
      id: 'guardian-new',
      hasLogin: true,
      email: 'meena@example.com',
    });
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'guardian.added',
      entityType: 'student_guardian',
      entityId: 'guardian-new',
      institutionId: 'institution-1',
    });
    expect(JSON.stringify(t.record.mock.calls)).not.toContain('meena@example.com');
    expect(t.welcomeAs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-new' }),
      5,
      'Sunrise Trust',
    );
  });

  it('locks the student first and adds a guardian without an email loginless and unmailed', async () => {
    const t = build();
    const result = await t.service.add(admin, 'student-1', newGuardian({ email: null }));
    expect(t.findStudent).toHaveBeenCalledWith(expect.anything(), 'student-1', true);
    expect(t.linkGuardian).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ hasLogin: false, email: null });
    expect(t.welcomeAs).not.toHaveBeenCalled();
  });

  it('hands the primary place over before it adds a new primary, and leaves it alone otherwise', async () => {
    const t = build();
    await t.service.add(admin, 'student-1', newGuardian({ isPrimary: true }));
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'guardian-0',
      expect.objectContaining({ is_primary: false, updated_by: 'admin-1' }),
    );
    expect(t.update.mock.invocationCallOrder[0]).toBeLessThan(
      t.insertGuardians.mock.invocationCallOrder[0]!,
    );
    expect(t.record.mock.calls.map(([, entry]) => entry.action)).toEqual([
      'guardian.updated',
      'guardian.added',
    ]);
    const other = build();
    await other.service.add(admin, 'student-1', newGuardian({ isPrimary: false }));
    expect(other.primaryOf).not.toHaveBeenCalled();
  });

  it('is 422 GUARDIAN_LIMIT_REACHED for a sixth guardian, before any account is made', async () => {
    const five = Array.from({ length: 5 }, (_, i) => guardian({ id: `g-${i.toString()}` }));
    const t = build({ guardians: five });
    expect(await refusal(t.service.add(admin, 'student-1', newGuardian()))).toEqual({
      status: 422,
      code: 'GUARDIAN_LIMIT_REACHED',
    });
    expect(t.linkGuardian).not.toHaveBeenCalled();
    expect(t.insertGuardians).not.toHaveBeenCalled();
  });

  it('is 409 ALREADY_GUARDIAN when the person already is a guardian of the student, in the check and on the unique index', async () => {
    const t = build();
    t.isLinked.mockResolvedValue(true);
    expect(await refusal(t.service.add(admin, 'student-1', newGuardian()))).toEqual({
      status: 409,
      code: 'ALREADY_GUARDIAN',
    });
    expect(t.insertGuardians).not.toHaveBeenCalled();
    expect(t.welcomeAs).not.toHaveBeenCalled();
    const raced = build();
    raced.insertGuardians.mockRejectedValue(unique('uq_student_guardians_student_user'));
    expect(await refusal(raced.service.add(admin, 'student-1', newGuardian()))).toEqual({
      status: 409,
      code: 'ALREADY_GUARDIAN',
    });
  });

  it('is 404 for a deactivated student and one the caller does not reach, and lets other failures through', async () => {
    expect(
      (
        await refusal(
          build({ student: student({ status: 0 }) }).service.add(admin, 'student-1', newGuardian()),
        )
      ).status,
    ).toBe(404);
    expect(
      (await refusal(build({ student: undefined }).service.add(admin, 'student-1', newGuardian())))
        .status,
    ).toBe(404);
    const t = build();
    t.linkGuardian.mockRejectedValue(AppException.conflict('ROLE_CONFLICT' as never));
    expect((await refusal(t.service.add(admin, 'student-1', newGuardian()))).code).toBe(
      'ROLE_CONFLICT',
    );
    t.insertGuardians.mockRejectedValue(new Error('boom'));
    t.linkGuardian.mockResolvedValue(person('user-new', 'm@example.com', true));
    await expect(t.service.add(admin, 'student-1', newGuardian())).rejects.toThrow('boom');
  });
});

describe('GuardianService.update (GDN-03)', () => {
  it('opens the Institution of the guardian, locks the student and then the guardian, and checks the version first', async () => {
    const t = build();
    await t.service.update(admin, 'guardian-1', edit({ occupation: 'Engineer' }));
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'institution-1');
    const locks = t.findStudent.mock.invocationCallOrder[0]!;
    expect(t.findStudent).toHaveBeenCalledWith(expect.anything(), 'student-1', true);
    expect(t.findGuardian).toHaveBeenLastCalledWith(expect.anything(), 'guardian-1', true);
    expect(locks).toBeLessThan(t.findGuardian.mock.invocationCallOrder.at(-1)!);
    const stale = build();
    expect(
      await refusal(
        stale.service.update(admin, 'guardian-1', edit({ version: 1, occupation: 'x' })),
      ),
    ).toEqual({ status: 409, code: 'VERSION_CONFLICT' });
    expect(stale.update).not.toHaveBeenCalled();
  });

  it('writes only what changed, stamps the author and audits the before and after without the numbers or the email', async () => {
    const t = build();
    const result = await t.service.update(
      admin,
      'guardian-1',
      edit({
        firstName: 'Ravi',
        occupation: 'Engineer',
        phone: { countryCode: '91', number: '9845000001' },
        relation: 1,
      }),
    );
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(t.update.mock.calls[0]![2]).toEqual({
      occupation: 'Engineer',
      country_code: undefined,
      phone_number: '9845000001',
      updated_by: 'admin-1',
    });
    expect(result).toMatchObject({ occupation: 'Engineer', version: 3 });
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'guardian.updated',
      before: { occupation: null, phone: '******2345' },
      after: { occupation: 'Engineer', phone: '******0001' },
    });
    expect(JSON.stringify(t.record.mock.calls)).not.toContain('ravi@example.com');
  });

  it('writes nothing for a request that changes nothing, and still answers with the guardian', async () => {
    const t = build();
    const result = await t.service.update(
      admin,
      'guardian-1',
      edit({ firstName: 'Ravi', email: 'RAVI@example.com' }),
    );
    expect(t.update).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'guardian-1', version: 2 });
  });

  it('is 404 for a removed guardian, one of a deactivated student, and one the caller does not reach', async () => {
    expect(
      (
        await refusal(
          build({ current: guardian({ status: 0 }) }).service.update(admin, 'guardian-1', edit()),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await refusal(
          build({ student: student({ status: 0 }) }).service.update(admin, 'guardian-1', edit()),
        )
      ).status,
    ).toBe(404);
    const unseen = build();
    unseen.requireInstitution.mockRejectedValue(AppException.notFound());
    expect((await refusal(unseen.service.update(admin, 'guardian-1', edit()))).status).toBe(404);
    const gone = build({ current: undefined });
    expect((await refusal(gone.service.update(admin, 'guardian-1', edit()))).status).toBe(404);
  });

  describe('the primary guardian', () => {
    it('is handed over by isPrimary true: the previous primary is demoted first, and each is audited', async () => {
      const t = build();
      const result = await t.service.update(admin, 'guardian-1', edit({ isPrimary: true }));
      expect(t.order.filter((entry) => entry.startsWith('update:'))).toEqual([
        'update:guardian-0',
        'update:guardian-1',
      ]);
      expect(t.update.mock.calls[0]![2]).toMatchObject({ is_primary: false });
      expect(t.update.mock.calls[1]![2]).toMatchObject({ is_primary: true });
      expect(result.isPrimary).toBe(true);
      expect(t.record.mock.calls.map(([, entry]) => [entry.action, entry.entityId])).toEqual([
        ['guardian.updated', 'guardian-0'],
        ['guardian.updated', 'guardian-1'],
      ]);
    });

    it('cannot be given up: isPrimary false for the primary is 422 PRIMARY_GUARDIAN_REQUIRED, and for another it changes nothing', async () => {
      const t = build({ current: primary });
      expect(
        await refusal(t.service.update(admin, 'guardian-0', edit({ isPrimary: false }))),
      ).toEqual({ status: 422, code: 'PRIMARY_GUARDIAN_REQUIRED' });
      expect(t.update).not.toHaveBeenCalled();
      const other = build();
      await other.service.update(admin, 'guardian-1', edit({ isPrimary: false }));
      expect(other.update).not.toHaveBeenCalled();
    });

    it('is left alone by isPrimary true for the primary itself', async () => {
      const t = build({ current: primary });
      await t.service.update(admin, 'guardian-0', edit({ isPrimary: true }));
      expect(t.update).not.toHaveBeenCalled();
      expect(t.primaryOf).not.toHaveBeenCalled();
    });
  });

  describe('the email', () => {
    it('changes the own email of a person who holds only this link: the link stays, both addresses are told', async () => {
      const t = build();
      t.changeGuardianEmail.mockResolvedValue(changeOf('edited'));
      const result = await t.service.update(
        admin,
        'guardian-1',
        edit({ email: 'New@Example.com' }),
      );
      expect(t.changeGuardianEmail.mock.calls[0]![1]).toMatchObject({
        userId: 'user-1',
        societyId: 'society-1',
        email: 'new@example.com',
        names: { firstName: 'Ravi', lastName: 'Shetty' },
        by: 'admin-1',
      });
      expect(t.update.mock.calls[0]![2]).toMatchObject({
        user_id: 'user-1',
        email: 'new@example.com',
      });
      expect(result).toMatchObject({ email: 'new@example.com', hasLogin: true });
      expect(t.record.mock.calls[0]![1]).toEqual({
        action: 'guardian.email_changed',
        institutionId: 'institution-1',
        entityType: 'student_guardian',
        entityId: 'guardian-1',
        before: { email: expect.stringContaining('***') as unknown, personId: 'user-1' },
        after: {
          email: expect.stringContaining('***') as unknown,
          personId: 'user-1',
          emailChanged: true,
          outcome: 'edited',
          sessionsEnded: 3,
        },
      });
      expect(JSON.stringify(t.record.mock.calls)).not.toContain('new@example.com');
      expect(t.announceGuardianEmail).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'edited' }),
        'Sunrise Trust',
      );
    });

    it('moves the link to the person the email belongs to, or to a new one, and the old person is told', async () => {
      const t = build();
      t.changeGuardianEmail.mockResolvedValue(
        changeOf('moved', person('user-9', 'new@example.com', true)),
      );
      const result = await t.service.update(
        admin,
        'guardian-1',
        edit({ email: 'new@example.com' }),
      );
      expect(t.update.mock.calls[0]![2]).toMatchObject({
        user_id: 'user-9',
        email: 'new@example.com',
      });
      expect(result.hasLogin).toBe(true);
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'guardian.email_changed',
        before: { personId: 'user-1' },
        after: { personId: 'user-9', outcome: 'moved', sessionsEnded: 1 },
      });
      expect(t.announceGuardianEmail).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'moved' }),
        'Sunrise Trust',
      );
    });

    it('vets the person it moves the link to: one who already is a guardian of this student is 409 ALREADY_GUARDIAN', async () => {
      const t = build();
      t.isLinked.mockResolvedValue(true);
      t.changeGuardianEmail.mockImplementation(async (_tx, request) => {
        await request.vet('user-9');
        return changeOf('moved');
      });
      expect(
        await refusal(t.service.update(admin, 'guardian-1', edit({ email: 'new@example.com' }))),
      ).toEqual({ status: 409, code: 'ALREADY_GUARDIAN' });
      expect(t.isLinked).toHaveBeenCalledWith(
        expect.anything(),
        'student-1',
        'user-9',
        'guardian-1',
      );
      expect(t.update).not.toHaveBeenCalled();
      expect(t.announceGuardianEmail).not.toHaveBeenCalled();
    });

    it('lines the copy on the guardian up with an account that already has the address, and tells nobody', async () => {
      const t = build({ current: guardian({ email: 'stale@example.com' }) });
      t.changeGuardianEmail.mockResolvedValue(changeOf('unchanged'));
      await t.service.update(admin, 'guardian-1', edit({ email: 'new@example.com' }));
      expect(t.update.mock.calls[0]![2]).toMatchObject({
        user_id: 'user-1',
        email: 'new@example.com',
      });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'guardian.email_changed',
        after: { outcome: 'synced' },
      });
      expect(t.announceGuardianEmail).not.toHaveBeenCalled();
      expect(t.announceGuardianRemoved).not.toHaveBeenCalled();
    });

    it('links a guardian who had no login to the person the email names, and welcomes them after the commit', async () => {
      const t = build({ current: guardian({ user_id: null, email: null }) });
      const result = await t.service.update(
        admin,
        'guardian-1',
        edit({ email: 'New@Example.com', firstName: 'Ravindra' }),
      );
      expect(t.linkGuardian).toHaveBeenCalledWith(
        expect.anything(),
        { email: 'new@example.com', firstName: 'Ravindra', lastName: 'Shetty' },
        'admin-1',
      );
      expect(t.changeGuardianEmail).not.toHaveBeenCalled();
      expect(t.update.mock.calls[0]![2]).toMatchObject({
        user_id: 'user-new',
        email: 'new@example.com',
        first_name: 'Ravindra',
      });
      expect(result.hasLogin).toBe(true);
      expect(t.record.mock.calls.map(([, entry]) => entry.action)).toEqual([
        'guardian.updated',
        'guardian.email_changed',
      ]);
      expect(t.record.mock.calls[1]![1]).toMatchObject({ after: { outcome: 'linked' } });
      expect(t.welcomeAs).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-new' }),
        5,
        'Sunrise Trust',
      );
    });

    it('refuses to link a guardian to a person who already is a guardian of the student', async () => {
      const t = build({ current: guardian({ user_id: null, email: null }) });
      t.isLinked.mockResolvedValue(true);
      expect(
        (await refusal(t.service.update(admin, 'guardian-1', edit({ email: 'new@example.com' }))))
          .code,
      ).toBe('ALREADY_GUARDIAN');
      expect(t.update).not.toHaveBeenCalled();
    });

    it('takes the login away with null: the link ends, the parent sessions of the person end when it was their last child, the address is told', async () => {
      const t = build();
      const result = await t.service.update(admin, 'guardian-1', edit({ email: null }));
      expect(t.endParentSessionsIfLast).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        expect.any(Date),
      );
      expect(t.update.mock.calls[0]![2]).toMatchObject({ user_id: null, email: null });
      expect(result).toMatchObject({ hasLogin: false, email: null });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'guardian.email_changed',
        after: { outcome: 'unlinked', sessionsEnded: 2, personId: null },
      });
      expect(t.announceGuardianRemoved).toHaveBeenCalledWith('ravi@example.com');
    });

    it('does nothing for null on a guardian who has no login', async () => {
      const t = build({ current: guardian({ user_id: null, email: null }) });
      await t.service.update(admin, 'guardian-1', edit({ email: null }));
      expect(t.update).not.toHaveBeenCalled();
      expect(t.endParentSessionsIfLast).not.toHaveBeenCalled();
    });

    it('turns the unique index into 409 ALREADY_GUARDIAN when two requests link one person, and lets other failures through', async () => {
      const t = build();
      t.changeGuardianEmail.mockResolvedValue(changeOf('moved'));
      t.update.mockRejectedValueOnce(unique('uq_student_guardians_student_user'));
      expect(
        (await refusal(t.service.update(admin, 'guardian-1', edit({ email: 'new@example.com' }))))
          .code,
      ).toBe('ALREADY_GUARDIAN');
      t.update.mockRejectedValueOnce(new Error('boom'));
      await expect(
        t.service.update(admin, 'guardian-1', edit({ email: 'new@example.com' })),
      ).rejects.toThrow('boom');
    });

    it('tells nobody when the transaction fails', async () => {
      const t = build();
      t.changeGuardianEmail.mockResolvedValue(changeOf('moved'));
      t.update.mockRejectedValue(new Error('boom'));
      await expect(
        t.service.update(admin, 'guardian-1', edit({ email: 'new@example.com' })),
      ).rejects.toThrow('boom');
      expect(t.announceGuardianEmail).not.toHaveBeenCalled();
    });
  });
});

describe('GuardianService.remove (GDN-04)', () => {
  it('removes a guardian who is not the primary: status 0, the parent sessions of the person end when it was their last child, audited, and the address is told', async () => {
    const t = build();
    expect(await t.service.remove(admin, 'guardian-1')).toEqual({ id: 'guardian-1', status: 0 });
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'guardian-1',
      expect.objectContaining({ status: 0, updated_by: 'admin-1' }),
    );
    expect(t.endParentSessionsIfLast).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.any(Date),
    );
    expect(t.record.mock.calls[0]![1]).toMatchObject({
      action: 'guardian.removed',
      entityType: 'student_guardian',
      entityId: 'guardian-1',
      before: { studentId: 'student-1', status: 1 },
      after: { status: 0, sessionsEnded: 2 },
    });
    expect(t.announceGuardianRemoved).toHaveBeenCalledWith('ravi@example.com');
    expect(t.findStudent).toHaveBeenCalledWith(expect.anything(), 'student-1', true);
  });

  it('ends no session and sends no mail for a guardian without a login', async () => {
    const t = build({ current: guardian({ user_id: null, email: null }) });
    await t.service.remove(admin, 'guardian-1');
    expect(t.endParentSessionsIfLast).not.toHaveBeenCalled();
    expect(t.announceGuardianRemoved).not.toHaveBeenCalled();
  });

  it('is 422 LAST_GUARDIAN for the only guardian, and 422 PRIMARY_GUARDIAN_REQUIRED for the primary', async () => {
    const only = build({
      guardians: [guardian({ is_primary: true })],
      current: guardian({ is_primary: true }),
    });
    expect(await refusal(only.service.remove(admin, 'guardian-1'))).toEqual({
      status: 422,
      code: 'LAST_GUARDIAN',
    });
    expect(only.update).not.toHaveBeenCalled();
    const head = build({ current: primary });
    expect(await refusal(head.service.remove(admin, 'guardian-0'))).toEqual({
      status: 422,
      code: 'PRIMARY_GUARDIAN_REQUIRED',
    });
    expect(head.update).not.toHaveBeenCalled();
    expect(head.endParentSessionsIfLast).not.toHaveBeenCalled();
  });

  it('is 404 for one already removed, one of a deactivated student and one the caller does not reach', async () => {
    expect(
      (
        await refusal(
          build({ current: guardian({ status: 0 }) }).service.remove(admin, 'guardian-1'),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await refusal(
          build({ student: student({ status: 0 }) }).service.remove(admin, 'guardian-1'),
        )
      ).status,
    ).toBe(404);
    const unseen = build();
    unseen.requireInstitution.mockRejectedValue(AppException.notFound());
    expect((await refusal(unseen.service.remove(admin, 'guardian-1'))).status).toBe(404);
  });
});
