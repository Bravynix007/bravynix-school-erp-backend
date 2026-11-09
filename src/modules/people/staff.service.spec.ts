import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { FileDirectory } from '../../platform/files/index.js';
import type {
  AccountDirectory,
  PersonDirectory,
  StaffEmailChange,
} from '../../platform/identity/index.js';
import type { MasterReferences } from '../../platform/masters/index.js';
import type { SubjectDirectory } from '../academic-setup/index.js';
import type { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import type { CreateStaffDto, ListStaffQueryDto, UpdateStaffDto } from './staff.dto.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';
import { StaffService } from './staff.service.js';

const owner = {
  personId: 'owner-1',
  sessionId: 'session-1',
  roleCode: 2,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
} as Principal;

const staff = (overrides: Partial<StaffRow> = {}): StaffRow =>
  ({
    id: 'staff-1',
    created_at: new Date('2026-11-01T00:00:00.000Z'),
    created_by: 'owner-1',
    updated_at: new Date('2026-11-01T00:00:00.000Z'),
    updated_by: 'owner-1',
    version: 1,
    status: 1,
    society_id: 'society-1',
    home_institution_id: 'institution-1',
    user_id: 'user-1',
    access_blocked_at: null,
    access_blocked_by: null,
    employee_code: 'EMP-1',
    first_name: 'Meera',
    last_name: null,
    class_category_id: 'category-1',
    country_code: '91',
    mobile_number: '9876500001',
    alternate_phone: null,
    address_line_1: null,
    address_line_2: null,
    joining_date: '2024-06-03',
    resignation_date: null,
    ...overrides,
  }) as StaffRow;

const unique = (constraint: string) =>
  Object.assign(new Error('unique'), { code: '23505', constraint });

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

const body: CreateStaffDto = {
  homeInstitutionId: 'institution-1',
  email: 'meera@example.com',
  firstName: 'Meera',
  classCategoryId: 'category-1',
  mobile: { countryCode: '91', number: '9876500001' },
};

function build(current: StaffRow | null = staff()) {
  const tx = {} as Tx;
  const order: string[] = [];
  const transaction = vi.fn<DatabaseService['transaction']>(async (_tenant, work) => {
    const result = await work(tx);
    order.push('commit');
    return result;
  });
  const find = vi.fn<StaffRepository['find']>().mockResolvedValue(current ?? undefined);
  const insert = vi
    .fn<StaffRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(staff({ ...(values as Partial<StaffRow>) })),
    );
  const update = vi
    .fn<StaffRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(staff({ ...current, ...(changes as Partial<StaffRow>), id, version: 2 })),
    );
  const replaceEducations = vi.fn<StaffRepository['replaceEducations']>().mockResolvedValue();
  const replaceEmergencyContacts = vi
    .fn<StaffRepository['replaceEmergencyContacts']>()
    .mockResolvedValue();
  const requireShown = vi.fn<MasterReferences['requireShown']>().mockResolvedValue(undefined);
  const requirePlace = vi.fn<MasterReferences['requirePlace']>().mockResolvedValue(undefined);
  const requireReady = vi.fn<FileDirectory['requireReady']>().mockResolvedValue(undefined);
  const subjectIds = vi.fn<StaffRepository['subjectIds']>().mockResolvedValue([]);
  const institutionIds = vi.fn<StaffRepository['institutionIds']>().mockResolvedValue([]);
  const replaceSubjects = vi.fn<StaffRepository['replaceSubjects']>().mockResolvedValue();
  const replaceInstitutions = vi.fn<StaffRepository['replaceInstitutions']>().mockResolvedValue();
  const endStaffAccessSessions = vi
    .fn<AccountDirectory['endStaffAccessSessions']>()
    .mockResolvedValue(3);
  const requireActive = vi.fn<SubjectDirectory['requireActive']>().mockResolvedValue();
  const requireActiveInstitutions = vi
    .fn<InstitutionDirectory['requireActive']>()
    .mockResolvedValue();
  const educations = vi.fn<StaffRepository['educations']>().mockResolvedValue([]);
  const emergencyContacts = vi.fn<StaffRepository['emergencyContacts']>().mockResolvedValue([]);
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
  const linkStaff = vi.fn<AccountDirectory['linkStaff']>().mockResolvedValue({
    id: 'user-1',
    email: 'meera@example.com',
    displayName: 'Meera',
    created: true,
  });
  const welcomeAs = vi.fn<AccountDirectory['welcomeAs']>(() => {
    order.push('welcome');
  });
  const endRoleSessions = vi.fn<AccountDirectory['endRoleSessions']>().mockResolvedValue(2);
  const person = { id: 'user-2', email: 'new@example.com', displayName: 'Meera', created: false };
  const changeStaffEmail = vi.fn<AccountDirectory['changeStaffEmail']>().mockResolvedValue({
    kind: 'edited',
    person,
    previousEmail: 'meera@example.com',
    sessionsEnded: 2,
  });
  const revokeAdminAccessOfStaff = vi
    .fn<AccountDirectory['revokeAdminAccessOfStaff']>()
    .mockResolvedValue({ institutionIds: [], sessionsEnded: 0 });
  const adminAccessOfStaff = vi
    .fn<AccountDirectory['adminAccessOfStaff']>()
    .mockResolvedValue({ active: [], dormant: [] });
  const releaseDormantAdminAccess = vi
    .fn<AccountDirectory['releaseDormantAdminAccess']>()
    .mockResolvedValue([]);
  const announceStaffEmail = vi.fn<AccountDirectory['announceStaffEmail']>(() => {
    order.push('announce');
  });
  const hasActiveRecord = vi.fn<StaffRepository['hasActiveRecord']>().mockResolvedValue(false);
  const page = vi
    .fn<StaffRepository['page']>()
    .mockResolvedValue({ rows: [current ?? staff()], total: 41 });
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new StaffService(
    { transaction } as unknown as DatabaseService,
    {
      find,
      insert,
      update,
      hasActiveRecord,
      page,
      replaceEducations,
      replaceEmergencyContacts,
      replaceSubjects,
      replaceInstitutions,
      subjectIds,
      institutionIds,
      educations,
      emergencyContacts,
    } as unknown as StaffRepository,
    { requireInstitution, forPrincipal } as unknown as ScopeService,
    {
      linkStaff,
      welcomeAs,
      endRoleSessions,
      endStaffAccessSessions,
      revokeAdminAccessOfStaff,
      adminAccessOfStaff,
      releaseDormantAdminAccess,
      changeStaffEmail,
      announceStaffEmail,
    } as unknown as AccountDirectory,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
      emails: vi
        .fn<PersonDirectory['emails']>()
        .mockResolvedValue(new Map([['user-1', 'meera@example.com']])),
    } as unknown as PersonDirectory,
    { requireShown, requirePlace } as unknown as MasterReferences,
    { requireReady } as unknown as FileDirectory,
    {
      names: vi.fn<InstitutionDirectory['names']>().mockResolvedValue(
        new Map([
          [
            'institution-1',
            {
              id: 'institution-1',
              name: 'Sunrise School',
              societyId: 'society-1',
              societyName: 'Sunrise Trust',
            },
          ],
        ]),
      ),
      requireActive: requireActiveInstitutions,
    } as unknown as InstitutionDirectory,
    { requireActive } as unknown as SubjectDirectory,
    { record } as unknown as AuditService,
    new FixedClock('2026-11-08T04:30:00.000Z'),
  );
  return {
    service,
    order,
    find,
    insert,
    update,
    replaceEducations,
    replaceEmergencyContacts,
    requireShown,
    requirePlace,
    requireReady,
    requireInstitution,
    linkStaff,
    welcomeAs,
    endRoleSessions,
    endStaffAccessSessions,
    revokeAdminAccessOfStaff,
    adminAccessOfStaff,
    releaseDormantAdminAccess,
    replaceSubjects,
    replaceInstitutions,
    subjectIds,
    institutionIds,
    requireActive,
    requireActiveInstitutions,
    changeStaffEmail,
    announceStaffEmail,
    hasActiveRecord,
    page,
    forPrincipal,
    record,
  };
}

const query = (fields: object = {}) =>
  Object.assign({ page: 2, limit: 20 }, fields) as ListStaffQueryDto;

describe('StaffService', () => {
  describe('create (STF-02)', () => {
    it('adds the record at the Institution the caller reaches, audits it, and mails the welcome after the commit', async () => {
      const t = build();
      const created = await t.service.create(owner, { ...body, employeeCode: 'EMP-1' });
      expect(t.requireInstitution).toHaveBeenCalledWith(owner, 'institution-1');
      expect(t.insert.mock.calls[0]![1]).toMatchObject({
        society_id: 'society-1',
        home_institution_id: 'institution-1',
        user_id: 'user-1',
        employee_code: 'EMP-1',
        created_by: 'owner-1',
      });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'staff.created',
        institutionId: 'institution-1',
        entityType: 'staff_member',
      });
      expect(t.welcomeAs).toHaveBeenCalledWith({ email: 'meera@example.com' }, 4, 'Sunrise Trust');
      expect(t.order).toEqual(['commit', 'welcome']);
      expect(created).toMatchObject({ firstName: 'Meera', person: { email: 'meera@example.com' } });
    });

    it('checks the dates before opening a transaction', async () => {
      const t = build();
      expect(
        await fail(t.service.create(owner, { ...body, dateOfBirth: '2026-11-08' })),
      ).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
      expect(t.linkStaff).not.toHaveBeenCalled();
    });

    it('turns the three unique indexes into their answers, and sends no welcome', async () => {
      for (const [constraint, status, code] of [
        ['uq_staff_members_home_employee_code', 409, 'EMPLOYEE_ID_TAKEN'],
        ['uq_staff_members_society_user', 409, 'DUPLICATE'],
        ['uq_staff_members_photo', 400, 'VALIDATION_FAILED'],
      ] as const) {
        const t = build();
        t.insert.mockRejectedValueOnce(unique(constraint));
        expect(await fail(t.service.create(owner, body))).toEqual({ status, code });
        expect(t.welcomeAs).not.toHaveBeenCalled();
      }
    });

    it('lets any other failure through', async () => {
      const t = build();
      t.insert.mockRejectedValueOnce(new Error('boom'));
      await expect(t.service.create(owner, body)).rejects.toThrow('boom');
    });
  });

  describe('list (STF-01)', () => {
    it('lists the staff of every Institution the caller reaches, active only, by name, with the login email', async () => {
      const t = build();
      t.forPrincipal.mockResolvedValue({
        tenant: { societyId: 'society-1', institutionIds: ['institution-1', 'institution-2'] },
      } as unknown as Awaited<ReturnType<ScopeService['forPrincipal']>>);
      const answer = await t.service.list(owner, query({ q: 'mee' }));
      expect(t.page).toHaveBeenCalledWith(
        expect.anything(),
        {
          q: 'mee',
          institutionIds: ['institution-1', 'institution-2'],
          statuses: [1],
          designationId: undefined,
          classCategoryId: undefined,
        },
        [{ field: 'name', direction: 'asc' }],
        20,
        20,
      );
      expect(t.requireInstitution).not.toHaveBeenCalled();
      expect(answer.options.meta).toEqual({ page: 2, limit: 20, totalItems: 41, totalPages: 3 });
      expect(answer.data).toEqual([
        expect.objectContaining({
          id: 'staff-1',
          person: { id: 'user-1', email: 'meera@example.com' },
          firstName: 'Meera',
        }),
      ]);
    });

    it('looks in the one Institution that is named, once the caller is known to reach it', async () => {
      const t = build();
      await t.service.list(owner, query({ institutionId: 'institution-1', status: [0, 1] }));
      expect(t.requireInstitution).toHaveBeenCalledWith(owner, 'institution-1');
      expect(t.page.mock.calls[0]![1]).toMatchObject({
        institutionIds: ['institution-1'],
        statuses: [0, 1],
      });
    });

    it('does not look in an Institution the caller does not reach', async () => {
      const t = build();
      t.requireInstitution.mockRejectedValue(AppException.notFound());
      expect(await fail(t.service.list(owner, query({ institutionId: 'institution-9' })))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(t.page).not.toHaveBeenCalled();
    });

    it('turns an unknown sort field into 400', async () => {
      const t = build();
      expect(await fail(t.service.list(owner, query({ sort: 'salary' })))).toMatchObject({
        status: 400,
        code: 'INVALID_SORT',
      });
    });
  });

  describe('get (STF-03)', () => {
    it('is 404 for a record that is not found, before the Institution is looked at', async () => {
      const t = build(null);
      expect(await fail(t.service.get(owner, 'staff-1'))).toMatchObject({ status: 404 });
      expect(t.requireInstitution).not.toHaveBeenCalled();
    });

    it('shows the record with the login email', async () => {
      const t = build();
      expect(await t.service.get(owner, 'staff-1')).toMatchObject({
        id: 'staff-1',
        person: { id: 'user-1', email: 'meera@example.com' },
      });
      expect(t.requireInstitution).toHaveBeenCalledWith(owner, 'institution-1');
    });
  });

  describe('update (STF-04)', () => {
    it('checks the version first', async () => {
      const t = build(staff({ version: 3 }));
      expect(
        await fail(t.service.update(owner, 'staff-1', { version: 2, firstName: 'X' })),
      ).toMatchObject({
        status: 409,
      });
      expect(t.update).not.toHaveBeenCalled();
    });

    it('is 404 for a deactivated record', async () => {
      const t = build(staff({ status: 0 }));
      expect(await fail(t.service.update(owner, 'staff-1', { version: 1 }))).toMatchObject({
        status: 404,
      });
    });

    it('writes and audits nothing when what is sent is what is stored', async () => {
      const t = build();
      const result = await t.service.update(owner, 'staff-1', {
        version: 1,
        firstName: 'Meera',
        employeeCode: 'EMP-1',
        educations: [],
        emergencyContacts: [],
      });
      expect(result).toMatchObject({ version: 1 });
      expect(t.update).not.toHaveBeenCalled();
      expect(t.replaceEducations).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('measures a resignation against the stored joining date', async () => {
      const t = build();
      expect(
        await fail(
          t.service.update(owner, 'staff-1', { version: 1, resignationDate: '2024-06-02' }),
        ),
      ).toMatchObject({ status: 400 });
    });

    it('writes the change with the stamp and audits before and after', async () => {
      const t = build();
      await t.service.update(owner, 'staff-1', { version: 1, firstName: 'Meena' });
      expect(t.update.mock.calls[0]![2]).toMatchObject({
        first_name: 'Meena',
        updated_by: 'owner-1',
      });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'staff.updated',
        before: expect.objectContaining({ firstName: 'Meera' }),
        after: expect.objectContaining({ firstName: 'Meena' }),
      });
    });

    it('checks the master rows, the place and the photo that are sent, in the home Institution', async () => {
      const t = build();
      await t.service.update(owner, 'staff-1', {
        version: 1,
        classCategoryId: 'category-2',
        designationId: 'designation-1',
        photoFileId: 'file-1',
        address: { countryId: 'country-1' },
      } as UpdateStaffDto);
      expect(t.requireShown.mock.calls.map((call) => call[1])).toEqual([
        'class_categories',
        'designations',
      ]);
      expect(t.requirePlace).toHaveBeenCalledTimes(1);
      expect(t.requireReady.mock.calls[0]![1]).toBe('file-1');
      expect(t.requireReady.mock.calls[0]![2]).toMatchObject({ institutionId: 'institution-1' });
    });

    it('replaces the emergency contacts that differ and leaves the ones that match', async () => {
      const t = build();
      await t.service.update(owner, 'staff-1', {
        version: 1,
        emergencyContacts: [
          {
            contactName: 'Ravi',
            phone: { countryCode: '91', number: '9000000001' },
            isPrimary: true,
          },
        ],
      } as UpdateStaffDto);
      expect(t.replaceEmergencyContacts).toHaveBeenCalledTimes(1);
    });

    it('replaces a list that differs', async () => {
      const t = build();
      await t.service.update(owner, 'staff-1', { version: 1, educations: [{ degree: 'B.Ed' }] });
      expect(t.replaceEducations).toHaveBeenCalledTimes(1);
    });

    it('turns a taken Employee ID into 409', async () => {
      const t = build();
      t.update.mockRejectedValueOnce(unique('uq_staff_members_home_employee_code'));
      expect(
        await fail(t.service.update(owner, 'staff-1', { version: 1, employeeCode: 'EMP-2' })),
      ).toEqual({
        status: 409,
        code: 'EMPLOYEE_ID_TAKEN',
      });
    });
  });

  describe('deactivate (STF-05)', () => {
    it('marks the record, ends the staff sessions in the Society, and audits the count', async () => {
      const t = build();
      expect(await t.service.deactivate(owner, 'staff-1')).toEqual({ id: 'staff-1', status: 0 });
      expect(t.update.mock.calls[0]![2]).toMatchObject({ status: 0, updated_by: 'owner-1' });
      expect(t.endRoleSessions).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        4,
        'society-1',
        expect.any(Date),
      );
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'staff.deactivated',
        after: { status: 0, sessionsEnded: 2 },
      });
    });

    it('takes the Admin grants of the record with it and counts their sessions', async () => {
      const t = build();
      t.revokeAdminAccessOfStaff.mockResolvedValue({
        institutionIds: ['institution-1', 'institution-2'],
        sessionsEnded: 3,
      });
      await t.service.deactivate(owner, 'staff-1');
      expect(t.revokeAdminAccessOfStaff).toHaveBeenCalledWith(
        expect.anything(),
        'staff-1',
        'owner-1',
        'staff_deactivated',
        expect.any(Date),
      );
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        after: {
          status: 0,
          sessionsEnded: 5,
          adminRevoked: ['institution-1', 'institution-2'],
        },
      });
    });

    it('refuses the caller’s own record and a record already deactivated', async () => {
      const own = build(staff({ user_id: 'owner-1' }));
      expect(await fail(own.service.deactivate(owner, 'staff-1'))).toEqual({
        status: 409,
        code: 'CANNOT_ACT_ON_SELF',
      });
      expect(own.update).not.toHaveBeenCalled();
      const gone = build(staff({ status: 0 }));
      expect(await fail(gone.service.deactivate(owner, 'staff-1'))).toMatchObject({ status: 404 });
    });
  });

  describe('changeEmail (STF-13)', () => {
    const request = { email: 'New@Example.com', version: 1 };
    const person = { id: 'user-2', email: 'new@example.com', displayName: 'Meera', created: false };

    it('changes the login, touches the record, audits masked addresses and tells both after the commit', async () => {
      const t = build();
      const changed = await t.service.changeEmail(owner, 'staff-1', request);
      expect(t.changeStaffEmail.mock.calls[0]![1]).toMatchObject({
        userId: 'user-1',
        societyId: 'society-1',
        email: 'New@Example.com',
        names: { firstName: 'Meera', lastName: null },
        by: 'owner-1',
      });
      expect(t.update.mock.calls[0]![2]).toEqual({ updated_by: 'owner-1' });
      const audit = t.record.mock.calls[0]![1];
      expect(audit).toMatchObject({
        action: 'staff.email_changed',
        institutionId: 'institution-1',
        before: { email: 'm***@example.com', personId: 'user-1' },
        after: { email: 'n***@example.com', outcome: 'edited', sessionsEnded: 2 },
      });
      expect(JSON.stringify(audit)).not.toContain('meera@example.com');
      expect(t.announceStaffEmail).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'edited' }),
        'Sunrise Trust',
      );
      expect(t.order).toEqual(['commit', 'commit', 'announce', 'commit']);
      expect(changed.version).toBe(2);
    });

    it('moves the record to the other person when the directory says so', async () => {
      const t = build();
      const moved: StaffEmailChange = {
        kind: 'moved',
        person,
        previousEmail: 'meera@example.com',
        sessionsEnded: 1,
        adminRevoked: ['institution-1'],
      };
      t.changeStaffEmail.mockResolvedValue(moved);
      await t.service.changeEmail(owner, 'staff-1', request);
      expect(t.changeStaffEmail.mock.calls[0]![1]).toMatchObject({ staffMemberId: 'staff-1' });
      expect(t.update.mock.calls[0]![2]).toEqual({ user_id: 'user-2', updated_by: 'owner-1' });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        after: { personId: 'user-2', outcome: 'moved', adminRevoked: ['institution-1'] },
      });
    });

    it('writes, audits and tells nobody when the email is the one the person has', async () => {
      const t = build();
      t.changeStaffEmail.mockResolvedValue({ kind: 'unchanged', person });
      const same = await t.service.changeEmail(owner, 'staff-1', request);
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
      expect(t.announceStaffEmail).not.toHaveBeenCalled();
      expect(same.version).toBe(1);
    });

    it('checks the version before anything else', async () => {
      const t = build();
      expect(
        await fail(t.service.changeEmail(owner, 'staff-1', { ...request, version: 7 })),
      ).toEqual({
        status: 409,
        code: 'VERSION_CONFLICT',
      });
      expect(t.changeStaffEmail).not.toHaveBeenCalled();
    });

    it('refuses the caller’s own record and a deactivated record', async () => {
      const own = build(staff({ user_id: 'owner-1' }));
      expect(await fail(own.service.changeEmail(owner, 'staff-1', request))).toEqual({
        status: 409,
        code: 'CANNOT_ACT_ON_SELF',
      });
      expect(own.changeStaffEmail).not.toHaveBeenCalled();
      const gone = build(staff({ status: 0 }));
      expect(await fail(gone.service.changeEmail(owner, 'staff-1', request))).toMatchObject({
        status: 404,
      });
    });

    it('refuses an email whose person already has a record in this Society', async () => {
      const t = build();
      t.hasActiveRecord.mockResolvedValue(true);
      t.changeStaffEmail.mockImplementation(async (_tx, change) => {
        await change.vet('user-2');
        return {
          kind: 'moved',
          person,
          previousEmail: 'meera@example.com',
          sessionsEnded: 0,
          adminRevoked: [],
        };
      });
      expect(await fail(t.service.changeEmail(owner, 'staff-1', request))).toEqual({
        status: 409,
        code: 'EMAIL_IN_USE',
      });
      expect(t.hasActiveRecord).toHaveBeenCalledWith(expect.anything(), 'user-2', 'society-1');
      expect(t.update).not.toHaveBeenCalled();
      expect(t.announceStaffEmail).not.toHaveBeenCalled();
    });

    it('turns a second request that took the person first into 409 EMAIL_IN_USE', async () => {
      const t = build();
      t.changeStaffEmail.mockResolvedValue({
        kind: 'moved',
        person,
        previousEmail: 'm@example.com',
        sessionsEnded: 0,
        adminRevoked: [],
      });
      t.update.mockRejectedValue(unique('uq_staff_members_society_user'));
      expect(await fail(t.service.changeEmail(owner, 'staff-1', request))).toEqual({
        status: 409,
        code: 'EMAIL_IN_USE',
      });
    });
  });
  describe('block and unblock (STF-06, STF-07)', () => {
    it('blocks the staff role, ends the staff sessions of that Society, and audits it', async () => {
      const t = build();
      const result = await t.service.block(owner, 'staff-1');
      expect(t.update.mock.calls[0]![2]).toMatchObject({
        access_blocked_at: new Date('2026-11-08T04:30:00.000Z'),
        access_blocked_by: 'owner-1',
        updated_by: 'owner-1',
      });
      expect(t.endStaffAccessSessions).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'society-1',
        new Date('2026-11-08T04:30:00.000Z'),
      );
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'staff.blocked',
        before: { isBlocked: false },
        after: { isBlocked: true, sessionsEnded: 3 },
      });
      expect(result).toMatchObject({ isBlocked: true });
    });

    it('lifts the block without ending any session', async () => {
      const t = build(staff({ access_blocked_at: new Date(), access_blocked_by: 'owner-1' }));
      const result = await t.service.unblock(owner, 'staff-1');
      expect(t.update.mock.calls[0]![2]).toMatchObject({
        access_blocked_at: null,
        access_blocked_by: null,
      });
      expect(t.endStaffAccessSessions).not.toHaveBeenCalled();
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'staff.unblocked',
        before: { isBlocked: true },
        after: { isBlocked: false },
      });
      expect(result).toMatchObject({ isBlocked: false });
    });

    it('refuses to block a blocked record and to unblock one that is not, writing nothing', async () => {
      const blocked = build(staff({ access_blocked_at: new Date(), access_blocked_by: 'owner-1' }));
      expect(await fail(blocked.service.block(owner, 'staff-1'))).toEqual({
        status: 409,
        code: 'INVALID_STATE',
      });
      const open = build();
      expect(await fail(open.service.unblock(owner, 'staff-1'))).toEqual({
        status: 409,
        code: 'INVALID_STATE',
      });
      expect(blocked.update).not.toHaveBeenCalled();
      expect(open.update).not.toHaveBeenCalled();
    });

    describe('a staff member who is an Institution Admin', () => {
      const admin = { ...owner, personId: 'admin-1', roleCode: 3 } as Principal;

      it.each([
        ['block', staff()],
        ['unblock', staff({ access_blocked_at: new Date(), access_blocked_by: 'owner-1' })],
      ] as const)(
        'is for the Society Owner only: an Institution Admin gets 403 on %s, and nothing changes',
        async (action, record) => {
          const t = build(record);
          t.adminAccessOfStaff.mockResolvedValue({ active: ['institution-1'], dormant: [] });
          expect(await fail(t.service[action](admin, 'staff-1'))).toEqual({
            status: 403,
            code: 'FORBIDDEN',
          });
          expect(t.adminAccessOfStaff).toHaveBeenCalledWith(expect.anything(), 'staff-1');
          expect(t.update).not.toHaveBeenCalled();
          expect(t.endStaffAccessSessions).not.toHaveBeenCalled();
          expect(t.record).not.toHaveBeenCalled();
        },
      );

      it('counts access that went dormant with its Institution: 403, with nothing written', async () => {
        const t = build();
        t.adminAccessOfStaff.mockResolvedValue({ active: [], dormant: ['institution-2'] });
        expect(await fail(t.service.block(admin, 'staff-1'))).toEqual({
          status: 403,
          code: 'FORBIDDEN',
        });
        expect(t.update).not.toHaveBeenCalled();
        expect(t.endStaffAccessSessions).not.toHaveBeenCalled();
        expect(t.record).not.toHaveBeenCalled();
      });

      it('lets the Society Owner block and unblock them, without asking whether they are an Admin', async () => {
        const t = build();
        t.adminAccessOfStaff.mockResolvedValue({ active: ['institution-1'], dormant: [] });
        await t.service.block(owner, 'staff-1');
        expect(t.update).toHaveBeenCalledTimes(1);
        expect(t.adminAccessOfStaff).not.toHaveBeenCalled();
      });

      it('lets an Institution Admin block a staff member who is not an Admin', async () => {
        const t = build();
        await t.service.block(admin, 'staff-1');
        expect(t.update).toHaveBeenCalledTimes(1);
      });

      it('answers the caller’s own record with 409 first', async () => {
        const t = build(staff({ user_id: 'admin-1' }));
        t.adminAccessOfStaff.mockResolvedValue({ active: ['institution-1'], dormant: [] });
        expect(await fail(t.service.block(admin, 'staff-1'))).toEqual({
          status: 409,
          code: 'CANNOT_ACT_ON_SELF',
        });
      });
    });

    it('refuses the caller’s own record and a deactivated one', async () => {
      expect(
        await fail(build(staff({ user_id: 'owner-1' })).service.block(owner, 'staff-1')),
      ).toEqual({ status: 409, code: 'CANNOT_ACT_ON_SELF' });
      expect(await fail(build(staff({ status: 0 })).service.block(owner, 'staff-1'))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  describe('setSubjects (STF-08)', () => {
    it('replaces the list, checking only the subjects that are new to the person, and audits before and after', async () => {
      const t = build();
      t.subjectIds.mockResolvedValue(['subject-1', 'subject-2']);
      await t.service.setSubjects(owner, 'staff-1', { subjectIds: ['subject-3', 'subject-1'] });
      expect(t.requireActive).toHaveBeenCalledWith(expect.anything(), ['subject-3'], 'subjectIds');
      expect(t.replaceSubjects.mock.calls[0]![2]).toEqual([
        {
          society_id: 'society-1',
          staff_member_id: 'staff-1',
          subject_id: 'subject-3',
          created_by: 'owner-1',
        },
        {
          society_id: 'society-1',
          staff_member_id: 'staff-1',
          subject_id: 'subject-1',
          created_by: 'owner-1',
        },
      ]);
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'staff.subjects_changed',
        before: { subjectIds: ['subject-1', 'subject-2'] },
        after: { subjectIds: ['subject-1', 'subject-3'] },
      });
    });

    it('writes nothing for the same list in any order, and clears with an empty one', async () => {
      const t = build();
      t.subjectIds.mockResolvedValue(['subject-1', 'subject-2']);
      await t.service.setSubjects(owner, 'staff-1', { subjectIds: ['subject-2', 'subject-1'] });
      expect(t.replaceSubjects).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
      await t.service.setSubjects(owner, 'staff-1', { subjectIds: [] });
      expect(t.replaceSubjects.mock.calls[0]![2]).toEqual([]);
    });

    it('passes on the refusal of a subject that is not there or not active, and writes nothing', async () => {
      const t = build();
      t.requireActive.mockRejectedValue(AppException.notFound());
      expect(await fail(t.service.setSubjects(owner, 'staff-1', { subjectIds: ['x'] }))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(t.replaceSubjects).not.toHaveBeenCalled();
    });

    it('is 404 for a deactivated staff member', async () => {
      const t = build(staff({ status: 0 }));
      expect(await fail(t.service.setSubjects(owner, 'staff-1', { subjectIds: [] }))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  describe('setInstitutions (STF-10)', () => {
    it('replaces the list after checking each new Institution, and audits before and after', async () => {
      const t = build();
      t.institutionIds.mockResolvedValue(['institution-2']);
      await t.service.setInstitutions(owner, 'staff-1', {
        institutionIds: ['institution-3', 'institution-2'],
      });
      // Only the Institution new to the person is checked, with its place in the list.
      expect(t.requireActiveInstitutions).toHaveBeenCalledTimes(1);
      expect(t.requireActiveInstitutions).toHaveBeenCalledWith(expect.anything(), [
        { id: 'institution-3', field: 'institutionIds[0]' },
      ]);
      expect(t.replaceInstitutions.mock.calls[0]![2]).toMatchObject([
        { staff_member_id: 'staff-1', institution_id: 'institution-3' },
        { staff_member_id: 'staff-1', institution_id: 'institution-2' },
      ]);
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'staff.institutions_changed',
        before: { institutionIds: ['institution-2'] },
        after: { institutionIds: ['institution-2', 'institution-3'] },
      });
    });

    it('refuses to drop an Institution the person is an Admin of, and keeps the ones that stay', async () => {
      const t = build();
      t.institutionIds.mockResolvedValue(['institution-2', 'institution-3']);
      t.adminAccessOfStaff.mockResolvedValue({ active: ['institution-3'], dormant: [] });
      expect(
        await fail(
          t.service.setInstitutions(owner, 'staff-1', { institutionIds: ['institution-2'] }),
        ),
      ).toEqual({ status: 409, code: 'ADMIN_ACCESS_HELD' });
      expect(t.replaceInstitutions).not.toHaveBeenCalled();
      await t.service.setInstitutions(owner, 'staff-1', {
        institutionIds: ['institution-3', 'institution-4'],
      });
      expect(t.replaceInstitutions).toHaveBeenCalledTimes(1);
    });

    it('ends dormant Admin access at a dropped Institution, keeps it where the Institution stays, and says so in the audit entry', async () => {
      const t = build();
      t.institutionIds.mockResolvedValue(['institution-2', 'institution-3']);
      t.adminAccessOfStaff.mockResolvedValue({
        active: [],
        dormant: ['institution-2', 'institution-3'],
      });
      t.releaseDormantAdminAccess.mockResolvedValue(['institution-2']);
      await t.service.setInstitutions(owner, 'staff-1', { institutionIds: ['institution-3'] });
      expect(t.releaseDormantAdminAccess).toHaveBeenCalledWith(
        expect.anything(),
        'staff-1',
        ['institution-2'],
        'staff_institution_removed',
      );
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        after: { institutionIds: ['institution-3'], adminRevoked: ['institution-2'] },
      });
    });

    it('writes nothing, not even the dormant access, when active Admin access holds a dropped Institution', async () => {
      const t = build();
      t.institutionIds.mockResolvedValue(['institution-2', 'institution-3']);
      t.adminAccessOfStaff.mockResolvedValue({
        active: ['institution-3'],
        dormant: ['institution-2'],
      });
      expect(
        await fail(t.service.setInstitutions(owner, 'staff-1', { institutionIds: [] })),
      ).toEqual({ status: 409, code: 'ADMIN_ACCESS_HELD' });
      expect(t.releaseDormantAdminAccess).not.toHaveBeenCalled();
    });

    it('lets an Admin of the home Institution change the extras, as the home is never in the list', async () => {
      const t = build();
      t.institutionIds.mockResolvedValue(['institution-2']);
      t.adminAccessOfStaff.mockResolvedValue({ active: ['institution-1'], dormant: [] });
      await t.service.setInstitutions(owner, 'staff-1', { institutionIds: ['institution-3'] });
      expect(t.replaceInstitutions).toHaveBeenCalledTimes(1);
    });

    it('writes nothing for the same list', async () => {
      const t = build();
      t.institutionIds.mockResolvedValue(['institution-2']);
      await t.service.setInstitutions(owner, 'staff-1', { institutionIds: ['institution-2'] });
      expect(t.replaceInstitutions).not.toHaveBeenCalled();
    });

    it('refuses the home Institution, naming its place in the list', async () => {
      const t = build();
      await expect(
        t.service.setInstitutions(owner, 'staff-1', {
          institutionIds: ['institution-2', 'institution-1'],
        }),
      ).rejects.toMatchObject({
        status: 400,
        options: { errors: [{ field: 'institutionIds[1]', code: 'INVALID_VALUE' }] },
      });
      expect(t.replaceInstitutions).not.toHaveBeenCalled();
    });

    it('passes on the refusal of an Institution that is not there or not active, and writes nothing', async () => {
      const t = build();
      t.requireActiveInstitutions.mockRejectedValue(
        AppException.referenceInactive('institutionIds[0]'),
      );
      expect(
        await fail(t.service.setInstitutions(owner, 'staff-1', { institutionIds: ['x'] })),
      ).toEqual({ status: 422, code: 'REFERENCE_INACTIVE' });
      expect(t.replaceInstitutions).not.toHaveBeenCalled();
    });
  });
});
