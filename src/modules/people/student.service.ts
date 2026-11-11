import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult, type WarningMeta } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { ErrorCode, FieldErrorCode, ResultCode } from '../../common/http/error-codes.js';
import { newId } from '../../common/ids/ids.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { Clock } from '../../common/time/clock.js';
import { fieldError } from '../../common/validation/field-error.js';
import { AuditService } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  isDuplicateOn,
  type Tx,
} from '../../platform/database/index.js';
import { FileDirectory, FilePurpose } from '../../platform/files/index.js';
import { AccountDirectory, PersonDirectory } from '../../platform/identity/index.js';
import { MasterReferences } from '../../platform/masters/index.js';
import { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import { AcademicYearDirectory, SectionDirectory } from '../academic-setup/index.js';
import { StudentContext } from './student-context.js';
import {
  STUDENT_SORT_FIELDS,
  type CreateStudentDto,
  type ListStudentsQueryDto,
  type StudentEnrolmentDto,
} from './student.dto.js';
import {
  StudentRepository,
  type GuardianRow,
  type PlacedRow,
  type StudentRow,
} from './student.repository.js';
import {
  studentResource,
  studentSummary,
  type StudentResource,
  type StudentSummary,
} from './student.resource.js';
import { requireValidStudent, studentAuditView } from './student.rules.js';

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

/** The warning of STU-02 when the section now holds more students than its capacity (PRD 7.3). */
const SECTION_OVER_CAPACITY = 'SECTION_OVER_CAPACITY';

/**
 * STU-01 to STU-03 (API design 9.6): the students of an Institution, each with the class and section they sit in and
 * their guardians. Society Owners reach every active Institution of their Society and Institution Admins their own;
 * a student whose Institution the caller does not reach is 404, never 403 (SDD 12.4). The teacher's classroom view,
 * editing, deactivation, moving section and the identity numbers arrive in the slices after this one.
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
   * `SECTION_NOT_IN_CLASS`, `PRIMARY_GUARDIAN_REQUIRED`; 409 `ROLE_CONFLICT` and `ACCOUNT_BLOCKED` for a guardian
   * email that cannot be linked. A section over its capacity is a warning, not a stop.
   */
  async create(principal: Principal, body: CreateStudentDto): Promise<ApiResult<StudentResource>> {
    const context = await this.scope.requireInstitution(principal, body.institutionId);
    const today = this.clock.todayIst();
    requireValidStudent(body, today);
    const created = await this.database
      .transaction(context.tenant, async (tx) => {
        await this.requireReferences(tx, body, context.institutionId);
        const capacity = await this.requirePlace(tx, body.enrolment, context.institutionId);
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
        const start = body.admissionDate ?? today;
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
    enrolment: StudentEnrolmentDto,
    institutionId: string,
  ): Promise<number | null> {
    const open = await this.years.openIn(tx, enrolment.academicYearId, institutionId);
    if (open === undefined) throw AppException.notFound();
    if (!open) throw AppException.businessRule(ErrorCode.YEAR_NOT_ACTIVE);
    const section = await this.sections.placeOf(tx, enrolment.sectionId);
    if (section?.institutionId !== institutionId) throw AppException.notFound();
    if (section.classId !== enrolment.classId) {
      throw AppException.businessRule(ErrorCode.SECTION_NOT_IN_CLASS);
    }
    if (!section.active) throw AppException.businessRule(ErrorCode.INACTIVE_SECTION);
    return section.capacity;
  }

  /** Does the section now hold more students than its capacity? A section with no capacity never does. */
  private async overCapacity(
    tx: Tx,
    enrolment: StudentEnrolmentDto,
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

const warnings = (...codes: string[]): WarningMeta => ({ warnings: codes });
