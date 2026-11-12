import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult, type WarningMeta } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { ErrorCode, FieldErrorCode, ResultCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { newId } from '../../common/ids/ids.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { Clock, dayBefore } from '../../common/time/clock.js';
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
import { MasterReferences, placeOf } from '../../platform/masters/index.js';
import { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import { AcademicYearDirectory, SectionDirectory } from '../academic-setup/index.js';
import { StudentContext } from './student-context.js';
import {
  STUDENT_SORT_FIELDS,
  type CreateStudentDto,
  type DeactivateStudentDto,
  type ListStudentsQueryDto,
  type MoveStudentDto,
  type StudentEnrolmentDto,
  type UpdateStudentDto,
} from './student.dto.js';
import {
  StudentRepository,
  type GuardianRow,
  type PlacedRow,
  type StudentChanges,
  type StudentRow,
} from './student.repository.js';
import {
  studentResource,
  studentSummary,
  type StudentResource,
  type StudentSummary,
} from './student.resource.js';
import {
  latestMoveDate,
  requireValidDates,
  requireValidMoveDate,
  requireValidStudent,
  studentAuditView,
} from './student.rules.js';

const ADMISSION_NO = 'uq_students_institution_admission_no';
const ROLL_NUMBER = 'uq_placements_roll';
const ONE_PHOTO_PER_CHILD = 'uq_students_photo';

/** A unique violation on the Admission ID, the roll number or the photo, in the words of the API (API design 12). */
function translate(error: unknown): unknown {
  if (isDuplicateOn(error, ADMISSION_NO))
    return AppException.conflict(ErrorCode.ADMISSION_NO_TAKEN);
  if (isDuplicateOn(error, ROLL_NUMBER)) return AppException.conflict(ErrorCode.ROLL_NUMBER_TAKEN);
  if (isDuplicateOn(error, ONE_PHOTO_PER_CHILD)) {
    return AppException.validation([fieldError('photoFileId', FieldErrorCode.INVALID_VALUE)]);
  }
  return error;
}

/** STU-05 reason 2, and the enrolment outcome 3 Left (DDD 9.6). */
const MADE_BY_MISTAKE = 2;
const ENROLMENT_LEFT = 3;

/** The warning of STU-02 when the section now holds more students than its capacity (PRD 7.3). */
const SECTION_OVER_CAPACITY = 'SECTION_OVER_CAPACITY';

/**
 * STU-01 to STU-05 and STU-08 (API design 9.6): the students of an Institution, each with the class and section they
 * sit in and their guardians. Society Owners reach every active Institution of their Society and Institution Admins
 * their own; a student whose Institution the caller does not reach is 404, never 403 (SDD 12.4). The teacher's
 * classroom view and the identity numbers arrive in the slices after this one.
 */
@Injectable()
export class StudentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly students: StudentRepository,
    private readonly scope: ScopeService,
    private readonly context: StudentContext,
    private readonly accounts: AccountDirectory,
    private readonly people: PersonDirectory,
    private readonly masters: MasterReferences,
    private readonly files: FileDirectory,
    private readonly years: AcademicYearDirectory,
    private readonly sections: SectionDirectory,
    private readonly institutions: InstitutionDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * STU-02: adds a student with the class and section they start in, and their guardians, in one transaction. A
   * guardian's email links the person it belongs to (one email can be several children's, PRD decision 12) or makes
   * a Pending account; the welcome mails go after the commit. The placement starts on `admissionDate`, or today.
   * 409 `ADMISSION_NO_TAKEN`, 409 `ROLL_NUMBER_TAKEN`; 422 `YEAR_NOT_ACTIVE`, `INACTIVE_SECTION`,
   * `SECTION_NOT_IN_CLASS`, `PRIMARY_GUARDIAN_REQUIRED`; 409 `ROLE_CONFLICT` (a Super Admin) and `ACCOUNT_BLOCKED` for a guardian
   * email that cannot be linked. A section over its capacity is a warning, not a stop.
   */
  async create(principal: Principal, body: CreateStudentDto): Promise<ApiResult<StudentResource>> {
    const context = await this.scope.requireInstitution(principal, body.institutionId);
    const today = this.clock.todayIst();
    requireValidStudent(body, today);
    const created = await this.database
      .transaction(context.tenant, async (tx) => {
        await this.requireReferences(tx, body, context.institutionId);
        const {
          capacity,
          startDate: yearStart,
          endDate: yearEnd,
        } = await this.requirePlace(tx, body.enrolment, context.institutionId);
        const start = placementStart(body.admissionDate ?? null, today, yearStart, yearEnd);
        const guardians = [];
        for (const guardian of body.guardians) {
          const person =
            guardian.email == null
              ? null
              : await this.accounts.linkGuardian(
                  tx,
                  {
                    email: guardian.email,
                    firstName: guardian.firstName,
                    lastName: guardian.lastName ?? undefined,
                  },
                  principal.personId,
                );
          guardians.push({ guardian, person });
        }

        const id = newId();
        const base = {
          society_id: context.societyId,
          institution_id: context.institutionId,
          ...insertStamp(principal.personId),
        };
        const row = await this.students.insert(tx, {
          ...base,
          id,
          admission_no: body.admissionNo ?? null,
          first_name: body.firstName,
          last_name: body.lastName ?? null,
          gender: body.gender ?? null,
          date_of_birth: body.dateOfBirth ?? null,
          blood_group: body.bloodGroup ?? null,
          nationality: body.nationality ?? null,
          photo_file_id: body.photoFileId ?? null,
          admission_date: body.admissionDate ?? null,
          contact_email: body.contactEmail?.toLowerCase() ?? null,
          country_code: body.mobile.countryCode,
          mobile_number: body.mobile.number,
          alternate_number: body.alternateNumber ?? null,
          address_line_1: body.address?.line1 ?? null,
          address_line_2: body.address?.line2 ?? null,
          country_id: body.address?.countryId ?? null,
          state_id: body.address?.stateId ?? null,
          city_id: body.address?.cityId ?? null,
          pincode: body.address?.pincode ?? null,
        });
        const enrolment = await this.students.insertEnrolment(tx, {
          ...base,
          academic_year_id: body.enrolment.academicYearId,
          student_id: id,
          class_id: body.enrolment.classId,
          enrolled_date: start,
        });
        const placement = await this.students.insertPlacement(tx, {
          ...base,
          academic_year_id: body.enrolment.academicYearId,
          student_enrolment_id: enrolment.id,
          class_id: body.enrolment.classId,
          section_id: body.enrolment.sectionId,
          roll_number: body.enrolment.rollNumber,
          start_date: start,
        });
        const guardianRows = await this.students.insertGuardians(
          tx,
          guardians.map(({ guardian, person }) => ({
            ...base,
            student_id: id,
            user_id: person?.id ?? null,
            first_name: guardian.firstName,
            last_name: guardian.lastName ?? null,
            relation: guardian.relation,
            country_code: guardian.phone.countryCode,
            phone_number: guardian.phone.number,
            alternate_phone: guardian.alternatePhone ?? null,
            email: person?.email ?? null,
            occupation: guardian.occupation ?? null,
            is_primary: guardian.isPrimary,
            is_emergency_contact: guardian.isEmergencyContact,
          })),
        );
        const placed: PlacedRow = {
          placement_id: placement.id,
          enrolment_id: enrolment.id,
          academic_year_id: placement.academic_year_id,
          class_id: placement.class_id,
          section_id: placement.section_id,
          roll_number: placement.roll_number,
          start_date: placement.start_date,
          enrolled_date: enrolment.enrolled_date,
        };
        await this.audit.record(tx, {
          action: 'student.created',
          institutionId: context.institutionId,
          entityType: 'student',
          entityId: id,
          after: studentAuditView(row, placed, guardianRows),
        });
        const society = await this.institutions.names(tx, [context.institutionId]);
        return {
          row,
          placed,
          guardianRows,
          emails: guardians.flatMap(({ person }) => (person ? [person.email] : [])),
          societyName: society.get(context.institutionId)?.societyName ?? null,
          overCapacity: await this.overCapacity(tx, body.enrolment, capacity),
        };
      })
      .catch((error: unknown) => {
        throw translate(error);
      });
    for (const email of created.emails) {
      this.accounts.welcomeAs({ email }, RoleCode.StudentParent, created.societyName);
    }
    const resource = await this.resource(created.row, created.placed, created.guardianRows);
    return new ApiResult(resource, {
      status: HttpStatus.CREATED,
      code: ResultCode.CREATED,
      meta: created.overCapacity ? warnings(SECTION_OVER_CAPACITY) : null,
    });
  }

  /**
   * STU-01: the students whose Institution the caller reaches, a page at a time; one Institution when `institutionId`
   * names it (404 when the caller does not reach it). Each is listed with the section they were last placed in, or the
   * one of `academicYearId`, and `classId` and `sectionId` filter on that. Active students only unless `status` asks
   * for others.
   */
  async list(
    principal: Principal,
    query: ListStudentsQueryDto,
  ): Promise<ApiResult<StudentSummary[]>> {
    const scope = await this.scope.forPrincipal(principal);
    const institutionIds = query.institutionId
      ? [(await this.scope.requireInstitution(principal, query.institutionId)).institutionId]
      : (scope.tenant.institutionIds ?? []);
    const sort = parseSort(query.sort, STUDENT_SORT_FIELDS, [{ field: 'name', direction: 'asc' }]);
    const { rows, total } = await this.database.transaction(scope.tenant, (tx) =>
      this.students.page(
        tx,
        {
          q: query.q,
          institutionIds,
          statuses: query.status ?? [1],
          academicYearId: query.academicYearId,
          classId: query.classId,
          sectionId: query.sectionId,
        },
        sort,
        query.limit,
        pageOffset(query.page, query.limit),
      ),
    );
    return ApiResult.list(rows.map(studentSummary), pageMeta(query.page, query.limit, total));
  }

  /** STU-03: the profile; 404 for a student who is not at an Institution the caller reaches. */
  async get(principal: Principal, id: string): Promise<StudentResource> {
    const context = await this.context.of(principal, id);
    const found = await this.database.transaction(context.tenant, async (tx) => {
      const row = await this.students.find(tx, id);
      if (!row) throw AppException.notFound();
      return {
        row,
        placed: await this.students.placedNow(tx, id),
        guardians: await this.students.guardians(tx, id),
      };
    });
    return this.resource(found.row, found.placed, found.guardians);
  }

  /**
   * STU-04: `version` is checked first; a request that changes nothing writes nothing. The dates are checked as they
   * will stand (a date not sent keeps its stored value), and a link that is left alone is not looked at again. A
   * deactivated student is 404. 409 `ADMISSION_NO_TAKEN`; 400 on a photo or place that does not fit.
   */
  async update(principal: Principal, id: string, body: UpdateStudentDto): Promise<StudentResource> {
    const context = await this.context.of(principal, id);
    const today = this.clock.todayIst();
    const updated = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.context.lockedActive(tx, id);
        requireVersion(current, body.version);
        requireValidDates(
          {
            dateOfBirth: body.dateOfBirth === undefined ? current.date_of_birth : body.dateOfBirth,
            admissionDate:
              body.admissionDate === undefined ? current.admission_date : body.admissionDate,
          },
          today,
        );
        const wanted: StudentChanges = {
          ...(body.firstName === undefined ? {} : { first_name: body.firstName }),
          last_name: body.lastName,
          admission_no: body.admissionNo,
          gender: body.gender,
          date_of_birth: body.dateOfBirth,
          blood_group: body.bloodGroup,
          nationality: body.nationality,
          photo_file_id: body.photoFileId,
          admission_date: body.admissionDate,
          contact_email: body.contactEmail === null ? null : body.contactEmail?.toLowerCase(),
          country_code: body.mobile?.countryCode,
          mobile_number: body.mobile?.number,
          alternate_number: body.alternateNumber,
          address_line_1: body.address?.line1,
          address_line_2: body.address?.line2,
          country_id: body.address?.countryId,
          state_id: body.address?.stateId,
          city_id: body.address?.cityId,
          pincode: body.address?.pincode,
        };
        const changes = changedColumns(current, wanted) as StudentChanges;
        const placed = await this.students.placedNow(tx, id);
        const guardians = await this.students.guardians(tx, id);
        if (Object.keys(changes).length === 0) return { row: current, placed, guardians };

        const placeChanged =
          'country_id' in changes || 'state_id' in changes || 'city_id' in changes;
        if (placeChanged) {
          await this.masters.requirePlace(
            tx,
            { ...placeOf(current), ...placeOf(changes) },
            'address',
            placeOf(current),
          );
        }
        if (changes.photo_file_id) {
          await this.files.requireReady(
            tx,
            changes.photo_file_id,
            { purpose: FilePurpose.StudentPhoto, institutionId: current.institution_id },
            'photoFileId',
          );
        }
        const row = await this.students.update(tx, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        await this.audit.record(tx, {
          action: 'student.updated',
          institutionId: row.institution_id,
          entityType: 'student',
          entityId: id,
          before: studentAuditView(current, placed, guardians),
          after: studentAuditView(row, placed, guardians),
        });
        return { row, placed, guardians };
      })
      .catch((error: unknown) => {
        throw translate(error);
      });
    return this.resource(updated.row, updated.placed, updated.guardians);
  }

  /**
   * STU-05: deactivates a student with a reason; nothing is deleted. The Admission ID and the roll number are free
   * again, because the open placement ends today, and the enrolment ends with the child: left today (outcome Left),
   * or cancelled when the record was made by mistake. The guardians keep their rows but lose the child, as the
   * section blocks and the parent's reads look only at active students. 404 when already deactivated.
   */
  async deactivate(
    principal: Principal,
    id: string,
    body: DeactivateStudentDto,
  ): Promise<{ id: string; status: 0 }> {
    const context = await this.context.of(principal, id);
    const today = this.clock.todayIst();
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.context.lockedActive(tx, id);
      const placed = await this.students.openPlacement(tx, id);
      const guardians = await this.students.guardians(tx, id);
      if (placed) {
        await this.students.updatePlacement(tx, placed.placement_id, {
          end_date: later(today, placed.start_date),
          ...updateStamp(principal.personId),
        });
        await this.students.updateEnrolment(tx, placed.enrolment_id, {
          ...(body.reason === MADE_BY_MISTAKE
            ? { status: 0 }
            : { left_date: later(today, placed.enrolled_date), outcome: ENROLMENT_LEFT }),
          ...updateStamp(principal.personId),
        });
      }
      const row = await this.students.update(tx, id, {
        status: 0,
        inactive_reason: body.reason,
        inactive_at: this.clock.now(),
        ...updateStamp(principal.personId),
      });
      await this.audit.record(tx, {
        action: 'student.deactivated',
        institutionId: row.institution_id,
        entityType: 'student',
        entityId: id,
        before: studentAuditView(current, placed, guardians),
        after: studentAuditView(row, placed, guardians),
      });
    });
    return { id, status: 0 };
  }

  /**
   * STU-08: moves the student to another section of their class, or gives them another roll number, from
   * `effectiveDate` (today when absent; not in the future, not before the current placement began). The open
   * placement ends the day before and a new one begins; on the day the current one began there is nothing to close,
   * so it is corrected in place. A request that changes nothing writes nothing. The class and the year stay (a new
   * class is promotion). 409 `ROLL_NUMBER_TAKEN`; 422 `INACTIVE_SECTION`, `SECTION_NOT_IN_CLASS`, `YEAR_NOT_ACTIVE`;
   * a full section is a warning, not a stop. A deactivated student is 404.
   */
  async move(
    principal: Principal,
    id: string,
    body: MoveStudentDto,
  ): Promise<ApiResult<StudentResource>> {
    const context = await this.context.of(principal, id);
    const today = this.clock.todayIst();
    const moved = await this.database
      .transaction(context.tenant, async (tx) => {
        const row = await this.context.lockedActive(tx, id);
        const open = await this.students.openPlacement(tx, id);
        if (!open) throw AppException.notFound();
        const guardians = await this.students.guardians(tx, id);
        const sectionId = body.sectionId ?? open.section_id;
        const rollNumber = body.rollNumber ?? open.roll_number;
        if (sectionId === open.section_id && rollNumber === open.roll_number) {
          return { row, placed: open, guardians, overCapacity: false };
        }
        const { capacity, endDate: yearEnd } = await this.requirePlace(
          tx,
          { academicYearId: open.academic_year_id, classId: open.class_id, sectionId },
          context.institutionId,
        );
        const effective = body.effectiveDate ?? latestMoveDate(open.start_date, today, yearEnd);
        requireValidMoveDate(effective, open.start_date, today, yearEnd);
        let placement: { id: string; start_date: string };
        if (effective === open.start_date) {
          await this.students.updatePlacement(tx, open.placement_id, {
            section_id: sectionId,
            roll_number: rollNumber,
            ...updateStamp(principal.personId),
          });
          placement = { id: open.placement_id, start_date: open.start_date };
        } else {
          await this.students.updatePlacement(tx, open.placement_id, {
            end_date: dayBefore(effective),
            ...updateStamp(principal.personId),
          });
          placement = await this.students.insertPlacement(tx, {
            society_id: row.society_id,
            institution_id: row.institution_id,
            ...insertStamp(principal.personId),
            academic_year_id: open.academic_year_id,
            student_enrolment_id: open.enrolment_id,
            class_id: open.class_id,
            section_id: sectionId,
            roll_number: rollNumber,
            start_date: effective,
          });
        }
        const placed: PlacedRow = {
          ...open,
          placement_id: placement.id,
          section_id: sectionId,
          roll_number: rollNumber,
          start_date: placement.start_date,
        };
        await this.audit.record(tx, {
          action: 'student.placement_changed',
          institutionId: row.institution_id,
          entityType: 'student',
          entityId: id,
          before: studentAuditView(row, open, guardians),
          after: studentAuditView(row, placed, guardians),
        });
        return {
          row,
          placed,
          guardians,
          overCapacity: await this.overCapacity(
            tx,
            { academicYearId: open.academic_year_id, sectionId },
            capacity,
          ),
        };
      })
      .catch((error: unknown) => {
        throw translate(error);
      });
    const resource = await this.resource(moved.row, moved.placed, moved.guardians);
    return new ApiResult(resource, {
      status: HttpStatus.OK,
      code: ResultCode.OK,
      meta: moved.overCapacity ? warnings(SECTION_OVER_CAPACITY) : null,
    });
  }

  private async resource(
    row: StudentRow,
    placed: PlacedRow | undefined,
    guardians: readonly GuardianRow[],
  ): Promise<StudentResource> {
    return studentResource(row, placed, guardians, await this.people.describe(authorIdsOf([row])));
  }

  /** The photo is a Ready file of this Institution; the place is a chain of the platform masters (400 otherwise). */
  private async requireReferences(
    tx: Tx,
    body: Pick<CreateStudentDto, 'photoFileId' | 'address'>,
    institutionId: string,
  ): Promise<void> {
    if (body.address) {
      await this.masters.requirePlace(tx, body.address, 'address', {});
    }
    if (body.photoFileId) {
      await this.files.requireReady(
        tx,
        body.photoFileId,
        { purpose: FilePurpose.StudentPhoto, institutionId },
        'photoFileId',
      );
    }
  }

  /**
   * The year is an active year of the Institution (404 for another's, 422 `YEAR_NOT_ACTIVE`), the section is one of
   * the Institution (404) that is open (422 `INACTIVE_SECTION`) and belongs to the class (422 `SECTION_NOT_IN_CLASS`).
   * Returns the section's capacity, or `null` for a section without a limit.
   */
  private async requirePlace(
    tx: Tx,
    enrolment: Pick<StudentEnrolmentDto, 'academicYearId' | 'classId' | 'sectionId'>,
    institutionId: string,
  ): Promise<{ capacity: number | null; startDate: string; endDate: string }> {
    const year = await this.years.openYear(tx, enrolment.academicYearId, institutionId);
    if (year === undefined) throw AppException.notFound();
    if (!year.open) throw AppException.businessRule(ErrorCode.YEAR_NOT_ACTIVE);
    const section = await this.sections.placeOf(tx, enrolment.sectionId);
    if (section?.institutionId !== institutionId) throw AppException.notFound();
    if (section.classId !== enrolment.classId) {
      throw AppException.businessRule(ErrorCode.SECTION_NOT_IN_CLASS);
    }
    if (!section.active) throw AppException.businessRule(ErrorCode.INACTIVE_SECTION);
    return { capacity: section.capacity, startDate: year.startDate, endDate: year.endDate };
  }

  /** Does the section now hold more students than its capacity? A section with no capacity never does. */
  private async overCapacity(
    tx: Tx,
    enrolment: Pick<StudentEnrolmentDto, 'academicYearId' | 'sectionId'>,
    capacity: number | null,
  ): Promise<boolean> {
    if (capacity === null) return false;
    const count = await this.students.sectionCount(
      tx,
      enrolment.academicYearId,
      enrolment.sectionId,
    );
    return count > capacity;
  }
}

/** The later of two `YYYY-MM-DD` days: a record never ends before it began. */
const later = (a: string, b: string): string => (a > b ? a : b);

const warnings = (...codes: string[]): WarningMeta => ({ warnings: codes });

/**
 * The first day of the enrolment and placement: inside the year (DATABASE_DESIGN, `enrolled_date` is the first day in
 * this class this year). An admission date before the year starts the year; one after it ends is 400 on
 * `admissionDate`. Without one, today, or the first day of a year that has not begun yet.
 */
export function placementStart(
  admissionDate: string | null,
  today: string,
  yearStart: string,
  yearEnd: string,
): string {
  if (admissionDate !== null && admissionDate > yearEnd) {
    throw AppException.validation([fieldError('admissionDate', FieldErrorCode.INVALID_VALUE)]);
  }
  const day = admissionDate ?? today;
  if (day < yearStart) return yearStart;
  return day > yearEnd ? yearEnd : day;
}
