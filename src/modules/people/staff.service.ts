import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
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
import { AccountDirectory, PersonDirectory } from '../../platform/identity/index.js';
import { MasterReferences } from '../../platform/masters/index.js';
import { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import type {
  CreateStaffDto,
  EducationDto,
  EmergencyContactDto,
  UpdateStaffDto,
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
import { staffResource, type StaffResource } from './staff.resource.js';
import { requireValidStaff, staffAuditView } from './staff.rules.js';

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
 * STF-02 to STF-05 (API design 9.5): the staff of a Society, each with a home Institution. Society Owners reach
 * every active Institution of their Society and Institution Admins their own; a record whose home Institution the
 * caller does not reach is 404, never 403 (SDD 12.4). The teacher's own view, the list, the email change, access
 * controls and identity numbers arrive in the slices after this one.
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
    return this.resource(created.row, created.educations, created.contacts, created.email);
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
   * staff end at once. Admin access and teaching assignments end here too once those exist. 404 when already
   * deactivated; 409 `CANNOT_ACT_ON_SELF` for the caller's own record.
   */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOf(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      if (current.user_id === principal.personId) {
        throw AppException.conflict(ErrorCode.CANNOT_ACT_ON_SELF);
      }
      const row = await this.staff.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      const ended = await this.accounts.endRoleSessions(
        tx,
        current.user_id,
        RoleCode.TeacherStaff,
        current.society_id,
        this.clock.now(),
      );
      await this.audit.record(tx, {
        action: 'staff.deactivated',
        institutionId: row.home_institution_id,
        entityType: 'staff_member',
        entityId: id,
        before: { status: current.status },
        after: { status: 0, sessionsEnded: ended },
      });
    });
    return { id, status: 0 };
  }

  /**
   * The Institution context of a staff member's home, once the caller is known to reach it: 404 for a person who is
   * not there, or who is at an Institution the caller does not reach; 423 for an Admin whose Institution has its
   * staff blocked.
   */
  private async contextOf(principal: Principal, id: string) {
    const scope = await this.scope.forPrincipal(principal);
    const home = await this.database.transaction(scope.tenant, async (tx) => {
      const found = await this.staff.find(tx, id);
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
    return this.resource(row, educations, contacts, email);
  }

  private async resource(
    row: StaffRow,
    educations: readonly EducationRow[],
    contacts: readonly EmergencyContactRow[],
    email: string,
  ): Promise<StaffResource> {
    return staffResource(
      row,
      educations,
      contacts,
      email,
      await this.people.describe(authorIdsOf([row])),
    );
  }
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
