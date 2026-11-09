import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { requireNotSelf } from '../../common/auth/require-not-self.js';
import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { newId } from '../../common/ids/ids.js';
import { Clock } from '../../common/time/clock.js';
import { fieldError } from '../../common/validation/field-error.js';
import { AuditService } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  isDuplicateOn,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import { FileDirectory, FilePurpose } from '../../platform/files/index.js';
import {
  AccountDirectory,
  maskEmail,
  PersonDirectory,
  type ChangeEmailDto,
} from '../../platform/identity/index.js';
import { MasterReferences } from '../../platform/masters/index.js';
import { SubjectDirectory } from '../academic-setup/index.js';
import { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import {
  STAFF_SORT_FIELDS,
  type CreateStaffDto,
  type EducationDto,
  type EmergencyContactDto,
  type ListStaffQueryDto,
  type SetStaffInstitutionsDto,
  type SetStaffSubjectsDto,
  type UpdateStaffDto,
} from './staff.dto.js';
import {
  StaffRepository,
  type EducationRow,
  type EmergencyContactRow,
  type NewEducation,
  type NewEmergencyContact,
  type StaffChanges,
  type StaffRow,
} from './staff.repository.js';
import {
  staffResource,
  staffSummary,
  type StaffAccess,
  type StaffResource,
  type StaffSummary,
} from './staff.resource.js';
import { requireValidStaff, staffAuditView } from './staff.rules.js';

/** Why the Admin grants of a staff record were revoked when the record was deactivated. */
const STAFF_DEACTIVATED = 'staff_deactivated';

const EMPLOYEE_CODE = 'uq_staff_members_home_employee_code';
const ONE_RECORD_PER_PERSON = 'uq_staff_members_society_user';
const ONE_PHOTO_PER_PERSON = 'uq_staff_members_photo';

/** A unique violation on the Employee ID, the login or the photo, in the words of the API (API design 12). */
function translate(error: unknown): unknown {
  if (isDuplicateOn(error, EMPLOYEE_CODE)) {
    return AppException.conflict(ErrorCode.EMPLOYEE_ID_TAKEN);
  }
  if (isDuplicateOn(error, ONE_RECORD_PER_PERSON))
    return AppException.conflict(ErrorCode.DUPLICATE);
  if (isDuplicateOn(error, ONE_PHOTO_PER_PERSON)) {
    return AppException.validation([fieldError('photoFileId', FieldErrorCode.INVALID_VALUE)]);
  }
  return error;
}

const educationRows = (
  societyId: string,
  staffId: string,
  list: readonly EducationDto[],
  by: string,
): NewEducation[] =>
  list.map((item) => ({
    id: newId(),
    society_id: societyId,
    staff_member_id: staffId,
    created_by: by,
    degree: item.degree,
    qualification: item.qualification ?? null,
    specialization: item.specialization ?? null,
    institution_name: item.institutionName ?? null,
    year_of_passing: item.yearOfPassing ?? null,
  }));

const contactRows = (
  societyId: string,
  staffId: string,
  list: readonly EmergencyContactDto[],
  by: string,
): NewEmergencyContact[] =>
  list.map((item) => ({
    id: newId(),
    society_id: societyId,
    staff_member_id: staffId,
    created_by: by,
    contact_name: item.contactName,
    relation: item.relation ?? null,
    country_code: item.phone.countryCode,
    phone_number: item.phone.number,
    alternate_phone: item.alternateNumber ?? null,
    is_primary: item.isPrimary,
  }));

/** The lists as text, so an edit that sends back what is stored writes nothing. */
const educationKey = (rows: readonly NewEducation[] | readonly EducationRow[]): string =>
  JSON.stringify(
    rows
      .map((row) => [
        row.degree,
        row.qualification,
        row.specialization,
        row.institution_name,
        row.year_of_passing,
      ])
      .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
const contactKey = (
  rows: readonly NewEmergencyContact[] | readonly EmergencyContactRow[],
): string =>
  JSON.stringify(
    rows
      .map((row) => [
        row.contact_name,
        row.relation,
        row.country_code,
        row.phone_number,
        row.alternate_phone,
        row.is_primary,
      ])
      .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );

/**
 * STF-01 to STF-08, STF-10 and STF-13 (API design 9.5): the staff of a Society, each with a home Institution. Society
 * Owners reach every active Institution of their Society and Institution Admins their own; a record whose home
 * Institution the caller does not reach is 404, never 403 (SDD 12.4). The class teacher, Admin access and identity
 * numbers arrive in the slices after this one.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly database: DatabaseService,
    private readonly staff: StaffRepository,
    private readonly scope: ScopeService,
    private readonly accounts: AccountDirectory,
    private readonly people: PersonDirectory,
    private readonly masters: MasterReferences,
    private readonly files: FileDirectory,
    private readonly institutions: InstitutionDirectory,
    private readonly subjects: SubjectDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * STF-02: adds a staff member at an Institution the caller reaches, and the login by email: a new email makes a
   * Pending account, an email that belongs to a person is that person. The welcome mail goes after the commit.
   * 409 `EMPLOYEE_ID_TAKEN`, 409 `DUPLICATE` (the person already has an active record in the Society), 409
   * `ROLE_CONFLICT` (a Super Admin), 409 `ACCOUNT_BLOCKED`.
   */
  async create(principal: Principal, body: CreateStaffDto): Promise<StaffResource> {
    const context = await this.scope.requireInstitution(principal, body.homeInstitutionId);
    requireValidStaff(body, this.clock.todayIst());
    const created = await this.database
      .transaction(context.tenant, async (tx) => {
        await this.requireReferences(
          tx,
          {
            classCategoryId: body.classCategoryId,
            designationId: body.designationId,
            photoFileId: body.photoFileId,
            place: body.address,
          },
          { institutionId: context.institutionId },
        );
        const person = await this.accounts.linkStaff(
          tx,
          { email: body.email, firstName: body.firstName, lastName: body.lastName ?? undefined },
          principal.personId,
        );
        const id = newId();
        const row = await this.staff.insert(tx, {
          id,
          society_id: context.societyId,
          home_institution_id: context.institutionId,
          user_id: person.id,
          employee_code: body.employeeCode ?? null,
          first_name: body.firstName,
          last_name: body.lastName ?? null,
          gender: body.gender ?? null,
          date_of_birth: body.dateOfBirth ?? null,
          blood_group: body.bloodGroup ?? null,
          nationality: body.nationality ?? null,
          photo_file_id: body.photoFileId ?? null,
          designation_id: body.designationId ?? null,
          class_category_id: body.classCategoryId,
          country_code: body.mobile.countryCode,
          mobile_number: body.mobile.number,
          alternate_phone: body.alternateNumber ?? null,
          address_line_1: body.address?.line1 ?? null,
          address_line_2: body.address?.line2 ?? null,
          country_id: body.address?.countryId ?? null,
          state_id: body.address?.stateId ?? null,
          city_id: body.address?.cityId ?? null,
          pincode: body.address?.pincode ?? null,
          joining_date: body.joiningDate ?? null,
          resignation_date: body.resignationDate ?? null,
          employment_type: body.employmentType ?? null,
          ...insertStamp(principal.personId),
        });
        await this.staff.replaceEducations(
          tx,
          id,
          educationRows(context.societyId, id, body.educations ?? [], principal.personId),
        );
        await this.staff.replaceEmergencyContacts(
          tx,
          id,
          contactRows(context.societyId, id, body.emergencyContacts ?? [], principal.personId),
        );
        const [educations, contacts] = await this.lists(tx, id);
        await this.audit.record(tx, {
          action: 'staff.created',
          institutionId: row.home_institution_id,
          entityType: 'staff_member',
          entityId: id,
          after: staffAuditView(row, educations, contacts),
        });
        const society = await this.institutions.names(tx, [context.institutionId]);
        return {
          row,
          educations,
          contacts,
          email: person.email,
          societyName: society.get(context.institutionId)?.societyName ?? null,
        };
      })
      .catch((error: unknown) => {
        throw translate(error);
      });
    this.accounts.welcomeAs({ email: created.email }, RoleCode.TeacherStaff, created.societyName);
    // A record that has just been made has no subjects and no extra Institutions yet.
    return this.resource(created.row, created.educations, created.contacts, created.email, {
      subjectIds: [],
      institutionIds: [],
    });
  }

  /**
   * STF-01: the staff whose home Institution the caller reaches, a page at a time; one Institution when
   * `institutionId` names it (404 when the caller does not reach it, 423 when it has its staff blocked and the
   * caller is staff). Active staff only unless `status` asks for others.
   */
  async list(principal: Principal, query: ListStaffQueryDto): Promise<ApiResult<StaffSummary[]>> {
    const scope = await this.scope.forPrincipal(principal);
    const institutionIds = query.institutionId
      ? [(await this.scope.requireInstitution(principal, query.institutionId)).institutionId]
      : (scope.tenant.institutionIds ?? []);
    const sort = parseSort(query.sort, STAFF_SORT_FIELDS, [{ field: 'name', direction: 'asc' }]);
    const { rows, total } = await this.database.transaction(scope.tenant, (tx) =>
      this.staff.page(
        tx,
        {
          q: query.q,
          institutionIds,
          statuses: query.status ?? [1],
          designationId: query.designationId,
          classCategoryId: query.classCategoryId,
          blocked: query.blocked,
          subjectId: query.subjectId,
        },
        sort,
        query.limit,
        pageOffset(query.page, query.limit),
      ),
    );
    const emails = await this.people.emails(rows.map((row) => row.user_id));
    return ApiResult.list(
      rows.map((row) => staffSummary(row, emails.get(row.user_id) ?? '')),
      pageMeta(query.page, query.limit, total),
    );
  }

  /** STF-03: the profile; 404 for a person who is not at an Institution the caller reaches. */
  async get(principal: Principal, id: string): Promise<StaffResource> {
    const context = await this.contextOf(principal, id);
    return this.database.transaction(context.tenant, async (tx) => {
      const row = await this.staff.find(tx, id);
      if (!row) throw AppException.notFound();
      const [educations, contacts] = await this.lists(tx, id);
      return this.resourceIn(tx, row, educations, contacts);
    });
  }

  /**
   * STF-04: `version` is checked first; a request that changes nothing writes nothing. The two lists, when sent,
   * replace the stored ones whole. A deactivated staff member is 404.
   */
  async update(principal: Principal, id: string, body: UpdateStaffDto): Promise<StaffResource> {
    const context = await this.contextOf(principal, id);
    const today = this.clock.todayIst();
    const updated = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        const [educationsBefore, contactsBefore] = await this.lists(tx, id);

        requireValidStaff(
          {
            dateOfBirth: body.dateOfBirth,
            joiningDate: body.joiningDate === undefined ? current.joining_date : body.joiningDate,
            resignationDate:
              body.resignationDate === undefined ? current.resignation_date : body.resignationDate,
            emergencyContacts: body.emergencyContacts,
          },
          today,
        );
        const wanted: StaffChanges = {
          ...(body.firstName === undefined ? {} : { first_name: body.firstName }),
          last_name: body.lastName,
          employee_code: body.employeeCode,
          gender: body.gender,
          date_of_birth: body.dateOfBirth,
          blood_group: body.bloodGroup,
          nationality: body.nationality,
          photo_file_id: body.photoFileId,
          designation_id: body.designationId,
          class_category_id: body.classCategoryId,
          country_code: body.mobile?.countryCode,
          mobile_number: body.mobile?.number,
          alternate_phone: body.alternateNumber,
          address_line_1: body.address?.line1,
          address_line_2: body.address?.line2,
          country_id: body.address?.countryId,
          state_id: body.address?.stateId,
          city_id: body.address?.cityId,
          pincode: body.address?.pincode,
          joining_date: body.joiningDate,
          resignation_date: body.resignationDate,
          employment_type: body.employmentType,
        };
        const changes = changedColumns(current, wanted) as StaffChanges;
        const newEducations =
          body.educations === undefined
            ? undefined
            : educationRows(current.society_id, id, body.educations, principal.personId);
        const newContacts =
          body.emergencyContacts === undefined
            ? undefined
            : contactRows(current.society_id, id, body.emergencyContacts, principal.personId);
        const educationsChanged =
          newEducations !== undefined &&
          educationKey(newEducations) !== educationKey(educationsBefore);
        const contactsChanged =
          newContacts !== undefined && contactKey(newContacts) !== contactKey(contactsBefore);
        if (Object.keys(changes).length === 0 && !educationsChanged && !contactsChanged) {
          return { row: current, educations: educationsBefore, contacts: contactsBefore };
        }

        const placeChanged =
          'country_id' in changes || 'state_id' in changes || 'city_id' in changes;
        await this.requireReferences(
          tx,
          {
            classCategoryId: changes.class_category_id,
            designationId: changes.designation_id,
            photoFileId: changes.photo_file_id,
            place: placeChanged ? { ...placeOf(current), ...placeOf(changes) } : undefined,
          },
          { institutionId: current.home_institution_id, currentPlace: placeOf(current) },
        );
        if (educationsChanged) await this.staff.replaceEducations(tx, id, newEducations);
        if (contactsChanged) await this.staff.replaceEmergencyContacts(tx, id, newContacts);
        const row = await this.staff.update(tx, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        const [educations, contacts] = await this.lists(tx, id);
        await this.audit.record(tx, {
          action: 'staff.updated',
          institutionId: row.home_institution_id,
          entityType: 'staff_member',
          entityId: id,
          before: staffAuditView(current, educationsBefore, contactsBefore),
          after: staffAuditView(row, educations, contacts),
        });
        return { row, educations, contacts };
      })
      .catch((error: unknown) => {
        throw translate(error);
      });
    return this.database.transaction(context.tenant, (tx) =>
      this.resourceIn(tx, updated.row, updated.educations, updated.contacts),
    );
  }

  /**
   * STF-05: deactivates a staff member; nothing is deleted, and the Employee ID is free again. Their sessions as
   * staff end at once, and so do their Institution Admin grants and the Admin sessions (INS-10). Teaching assignments
   * end here too once those exist. 404 when already deactivated; 409 `CANNOT_ACT_ON_SELF` for the caller's own
   * record.
   */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOf(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      requireNotSelf(principal.personId, current.user_id);
      const row = await this.staff.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      const now = this.clock.now();
      // The access belongs to the record: its Admin grants end with it, and the Admin sessions with them.
      const admin = await this.accounts.revokeAdminAccessOfStaff(
        tx,
        id,
        principal.personId,
        STAFF_DEACTIVATED,
        now,
      );
      const ended =
        admin.sessionsEnded +
        (await this.accounts.endRoleSessions(
          tx,
          current.user_id,
          RoleCode.TeacherStaff,
          current.society_id,
          now,
        ));
      await this.audit.record(tx, {
        action: 'staff.deactivated',
        institutionId: row.home_institution_id,
        entityType: 'staff_member',
        entityId: id,
        before: { status: current.status },
        after: { status: 0, sessionsEnded: ended, adminRevoked: admin.institutionIds },
      });
    });
    return { id, status: 0 };
  }

  /**
   * STF-06: blocks the staff role of an active staff member in this Society (DDD D-02). Their sessions as Institution
   * Admin or Teacher / Staff here end at once (`SESSION_ENDED`, reason `blocked`) and the role answers 403
   * `ACCESS_BLOCKED` until STF-07; their account, their other Societies and their Owner role are untouched. 404 when
   * deactivated; 409 `INVALID_STATE` when already blocked; 409 `CANNOT_ACT_ON_SELF` for the caller's own record; 403 for an
   * Institution Admin caller when the person is an Institution Admin (only a Society Owner may, API design 6.8).
   */
  async block(principal: Principal, id: string): Promise<StaffResource> {
    return this.setBlock(principal, id, true);
  }

  /** STF-07: lifts the block. 409 `INVALID_STATE` when the record is not blocked; otherwise as STF-06. */
  async unblock(principal: Principal, id: string): Promise<StaffResource> {
    return this.setBlock(principal, id, false);
  }

  private async setBlock(
    principal: Principal,
    id: string,
    blocked: boolean,
  ): Promise<StaffResource> {
    const context = await this.contextOf(principal, id);
    const now = this.clock.now();
    return this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      requireNotSelf(principal.personId, current.user_id);
      await this.requireOwnerForAdmin(tx, principal, id);
      if ((current.access_blocked_at !== null) === blocked) {
        throw AppException.conflict(ErrorCode.INVALID_STATE);
      }
      const row = await this.staff.update(tx, id, {
        access_blocked_at: blocked ? now : null,
        access_blocked_by: blocked ? principal.personId : null,
        ...updateStamp(principal.personId),
      });
      const sessionsEnded = blocked
        ? await this.accounts.endStaffAccessSessions(tx, current.user_id, current.society_id, now)
        : 0;
      await this.audit.record(tx, {
        action: blocked ? 'staff.blocked' : 'staff.unblocked',
        institutionId: row.home_institution_id,
        entityType: 'staff_member',
        entityId: id,
        before: { isBlocked: !blocked },
        after: { isBlocked: blocked, ...(blocked ? { sessionsEnded } : {}) },
      });
      return this.resourceOf(tx, row);
    });
  }

  /**
   * Only a Society Owner may block or unblock a staff member who is an Institution Admin, so an Admin cannot stop a
   * fellow Admin or undo an Owner's block (API design 6.8). Held access counts, active or restorable. Read under the
   * record lock the caller holds, so it cannot race a grant (INS-09). 403, with nothing changed.
   */
  private async requireOwnerForAdmin(tx: Tx, principal: Principal, id: string): Promise<void> {
    if (principal.roleCode === RoleCode.SocietyOwner) return;
    if ((await this.accounts.administeredInstitutionIds(tx, id)).length > 0) {
      throw AppException.forbidden();
    }
  }

  /**
   * STF-08: replaces the subjects the person can teach with this list (an empty one clears it). Each subject that is
   * new to the person must exist in the Society (404) and be active (422 `REFERENCE_INACTIVE`); one already on the
   * list stays even if it has been deactivated since. A list that changes nothing writes nothing. 404 when the
   * staff member is deactivated.
   */
  async setSubjects(
    principal: Principal,
    id: string,
    body: SetStaffSubjectsDto,
  ): Promise<StaffResource> {
    const context = await this.contextOf(principal, id);
    return this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      const before = await this.staff.subjectIds(tx, id);
      if (sameIds(before, body.subjectIds)) return this.resourceOf(tx, current);
      await this.subjects.requireActive(
        tx,
        body.subjectIds.filter((subject) => !before.includes(subject)),
        'subjectIds',
      );
      await this.staff.replaceSubjects(
        tx,
        id,
        body.subjectIds.map((subjectId) => ({
          society_id: current.society_id,
          staff_member_id: id,
          subject_id: subjectId,
          created_by: principal.personId,
        })),
      );
      await this.audit.record(tx, {
        action: 'staff.subjects_changed',
        institutionId: current.home_institution_id,
        entityType: 'staff_member',
        entityId: id,
        before: { subjectIds: before },
        after: { subjectIds: body.subjectIds.toSorted() },
      });
      return this.resourceOf(tx, current);
    });
  }

  /**
   * STF-10: replaces the extra Institutions the person may see (PRD 4; an empty list clears it). Each Institution
   * that is new to the person must exist in the Society (404), be active (422 `REFERENCE_INACTIVE`) and differ from
   * their home Institution (400 `INVALID_VALUE`). From the person's next call their scope reaches them. A list that
   * changes nothing writes nothing. Society Owners only.
   */
  async setInstitutions(
    principal: Principal,
    id: string,
    body: SetStaffInstitutionsDto,
  ): Promise<StaffResource> {
    const context = await this.contextOf(principal, id);
    return this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      const before = await this.staff.institutionIds(tx, id);
      if (sameIds(before, body.institutionIds)) return this.resourceOf(tx, current);
      // An Admin of an Institution must keep it as an extra Institution: revoke the access first. Access that an
      // Institution's deactivation took away, and a reactivation could return, counts as held.
      const administered = await this.accounts.administeredInstitutionIds(tx, id);
      const kept = new Set(body.institutionIds);
      if (
        administered.some(
          (institutionId) => before.includes(institutionId) && !kept.has(institutionId),
        )
      ) {
        throw AppException.conflict(ErrorCode.ADMIN_ACCESS_HELD);
      }
      const added = body.institutionIds.flatMap((institutionId, index) =>
        before.includes(institutionId)
          ? []
          : [{ id: institutionId, field: `institutionIds[${String(index)}]` }],
      );
      const home = added.find((item) => item.id === current.home_institution_id);
      if (home)
        throw AppException.validation([fieldError(home.field, FieldErrorCode.INVALID_VALUE)]);
      await this.institutions.requireActive(tx, added);
      await this.staff.replaceInstitutions(
        tx,
        id,
        body.institutionIds.map((institutionId) => ({
          society_id: current.society_id,
          staff_member_id: id,
          institution_id: institutionId,
          created_by: principal.personId,
        })),
      );
      await this.audit.record(tx, {
        action: 'staff.institutions_changed',
        institutionId: current.home_institution_id,
        entityType: 'staff_member',
        entityId: id,
        before: { institutionIds: before },
        after: { institutionIds: body.institutionIds.toSorted() },
      });
      return this.resourceOf(tx, current);
    });
  }

  /**
   * STF-13 (API design 6.6): changes the login email of an active staff member, at once. The person's own email
   * changes when this record is all they hold, else the record moves to the person the email belongs to or to a new
   * one; either way the sessions of the old login end and the addresses are told. The same email writes nothing and
   * keeps the version. 409 `EMAIL_IN_USE` (another person who has a record in this Society, or a second request that
   * took the email first), 409 `ROLE_CONFLICT`, 409 `ACCOUNT_BLOCKED`, 409 `CANNOT_ACT_ON_SELF`.
   */
  async changeEmail(
    principal: Principal,
    id: string,
    body: ChangeEmailDto,
  ): Promise<StaffResource> {
    const context = await this.contextOf(principal, id);
    const now = this.clock.now();
    const done = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        requireNotSelf(principal.personId, current.user_id);
        const change = await this.accounts.changeStaffEmail(tx, {
          staffMemberId: id,
          userId: current.user_id,
          societyId: current.society_id,
          email: body.email,
          names: { firstName: current.first_name, lastName: current.last_name },
          by: principal.personId,
          now,
          vet: async (personId) => {
            if (await this.staff.hasActiveRecord(tx, personId, current.society_id)) {
              throw AppException.conflict(ErrorCode.EMAIL_IN_USE);
            }
          },
        });
        if (change.kind === 'unchanged') return { row: current, change, societyName: null };
        const row = await this.staff.update(tx, id, {
          ...(change.kind === 'moved' ? { user_id: change.person.id } : {}),
          ...updateStamp(principal.personId),
        });
        await this.audit.record(tx, {
          action: 'staff.email_changed',
          institutionId: row.home_institution_id,
          entityType: 'staff_member',
          entityId: id,
          before: { email: maskEmail(change.previousEmail), personId: current.user_id },
          after: {
            email: maskEmail(change.person.email),
            personId: row.user_id,
            outcome: change.kind,
            sessionsEnded: change.sessionsEnded,
            ...(change.kind === 'moved' ? { adminRevoked: change.adminRevoked } : {}),
          },
        });
        const society = await this.institutions.names(tx, [row.home_institution_id]);
        return {
          row,
          change,
          societyName: society.get(row.home_institution_id)?.societyName ?? null,
        };
      })
      .catch((error: unknown) => {
        throw isDuplicateOn(error, ONE_RECORD_PER_PERSON)
          ? AppException.conflict(ErrorCode.EMAIL_IN_USE)
          : error;
      });
    if (done.change.kind !== 'unchanged') {
      this.accounts.announceStaffEmail(done.change, done.societyName);
    }
    return this.database.transaction(context.tenant, async (tx) => {
      const [educations, contacts] = await this.lists(tx, id);
      return this.resourceIn(tx, done.row, educations, contacts);
    });
  }

  /**
   * The Institution context of a staff member's home, once the caller is known to reach it: 404 for a person who is
   * not there, who is at an Institution the caller does not reach, or, for a teacher, is not the teacher; 423 for an Admin whose Institution has its
   * staff blocked.
   */
  private async contextOf(principal: Principal, id: string) {
    const scope = await this.scope.forPrincipal(principal);
    const home = await this.database.transaction(scope.tenant, async (tx) => {
      const found = await this.staff.find(tx, id);
      // A teacher reaches their own record and nobody else's, as if the others did not exist.
      if (principal.roleCode === RoleCode.TeacherStaff && found?.user_id !== principal.personId) {
        return undefined;
      }
      return found?.home_institution_id;
    });
    if (!home) throw AppException.notFound();
    return this.scope.requireInstitution(principal, home);
  }

  /** The record, locked for the change; 404 when gone or deactivated. */
  private async lockedActive(tx: Tx, id: string): Promise<StaffRow> {
    const row = await this.staff.find(tx, id, true);
    if (!row || row.status === 0) throw AppException.notFound();
    return row;
  }

  private async lists(tx: Tx, id: string): Promise<[EducationRow[], EmergencyContactRow[]]> {
    return [await this.staff.educations(tx, id), await this.staff.emergencyContacts(tx, id)];
  }

  /**
   * The masters and the photo a new or changed field points at: each must exist (404) and be shown (422
   * `REFERENCE_INACTIVE`); the place is a chain (400); the photo is a Ready file of purpose 4 in this Institution
   * (400 `INVALID_VALUE`). Only a value that is set is looked at, so a change that leaves a field alone leaves its
   * link alone, even if the master entry has been hidden since.
   */
  private async requireReferences(
    tx: Tx,
    links: {
      classCategoryId?: string | null;
      designationId?: string | null;
      photoFileId?: string | null;
      place?: Place;
    },
    where: { institutionId: string; currentPlace?: Place },
  ): Promise<void> {
    if (links.classCategoryId) {
      await this.masters.requireShown(
        tx,
        'class_categories',
        links.classCategoryId,
        'classCategoryId',
      );
    }
    if (links.designationId) {
      await this.masters.requireShown(tx, 'designations', links.designationId, 'designationId');
    }
    if (links.place) {
      await this.masters.requirePlace(tx, links.place, 'address', where.currentPlace ?? {});
    }
    if (links.photoFileId) {
      await this.files.requireReady(
        tx,
        links.photoFileId,
        { purpose: FilePurpose.StaffPhoto, institutionId: where.institutionId },
        'photoFileId',
      );
    }
  }

  private async resourceIn(
    tx: Tx,
    row: StaffRow,
    educations: readonly EducationRow[],
    contacts: readonly EmergencyContactRow[],
  ): Promise<StaffResource> {
    const email = (await this.people.emails([row.user_id])).get(row.user_id) ?? '';
    return this.resource(row, educations, contacts, email, {
      subjectIds: await this.staff.subjectIds(tx, row.id),
      institutionIds: await this.staff.institutionIds(tx, row.id),
    });
  }

  private async resource(
    row: StaffRow,
    educations: readonly EducationRow[],
    contacts: readonly EmergencyContactRow[],
    email: string,
    access: StaffAccess,
  ): Promise<StaffResource> {
    return staffResource(
      row,
      educations,
      contacts,
      email,
      access,
      await this.people.describe(authorIdsOf([row])),
    );
  }

  /** The record, with everything an access change returns, read in the caller's transaction. */
  private async resourceOf(tx: Tx, row: StaffRow): Promise<StaffResource> {
    const [educations, contacts] = await this.lists(tx, row.id);
    return this.resourceIn(tx, row, educations, contacts);
  }
}

/** Do two lists hold the same IDs, whatever their order? */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

type Place = { countryId?: string | null; stateId?: string | null; cityId?: string | null };

/** The place columns of a stored record or of a set of changes, as the master check names them. */
function placeOf(row: {
  country_id?: string | null;
  state_id?: string | null;
  city_id?: string | null;
}): Place {
  return {
    ...(row.country_id === undefined ? {} : { countryId: row.country_id }),
    ...(row.state_id === undefined ? {} : { stateId: row.state_id }),
    ...(row.city_id === undefined ? {} : { cityId: row.city_id }),
  };
}
