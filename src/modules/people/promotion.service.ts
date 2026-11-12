import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult, warnings } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode, ResultCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import { AuditService } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  isDuplicateOn,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import { IdempotencyService } from '../../platform/idempotency/index.js';
import { ScopeService } from '../../platform/tenancy/index.js';
import {
  AcademicYearDirectory,
  ClassDirectory,
  SectionDirectory,
} from '../academic-setup/index.js';
import type { PromoteClassDto, PromoteStudentDto, PromotionTargetDto } from './promotion.dto.js';
import { MAX_PROMOTED_AT_ONCE, oldPlacementEnd, outcomeOf, renumber } from './promotion.rules.js';
import { StudentContext } from './student-context.js';
import { StudentRepository, type PromotableRow } from './student.repository.js';
import type { StudentResource } from './student.resource.js';
import { StudentService } from './student.service.js';

/** The name the idempotency store keeps with a promotion (API design 14.5). */
const OPERATION = 'students.promote';
const ROLL_NUMBER = 'uq_placements_roll';
const SECTION_OVER_CAPACITY = 'SECTION_OVER_CAPACITY';

/** Why a student was left out of a promotion that went through. */
export const SKIP_NOT_IN_SOURCE = 'NOT_IN_SOURCE';
export const SKIP_ALREADY_ENROLLED = 'ALREADY_ENROLLED';

/** PRM-01's answer. */
export interface PromotionResult {
  promotedCount: number;
  skipped: { studentId: string; reason: string }[];
}

interface Target {
  academicYearId: string;
  classId: string;
  sectionId: string;
}

interface Plan {
  institutionId: string;
  personId: string;
  from: { academicYearId: string; classId: string; sectionId: string | null };
  /** `null`: the students complete the final class. */
  to: Target | null;
  studentIds?: readonly string[];
  keepRollNumbers: boolean;
  /** STU-09: the roll number the one student takes. */
  rollNumber?: string;
  /** STU-09: a student already enrolled in the target year is 409, not skipped. */
  single: boolean;
}

interface Done {
  promoted: PromotableRow[];
  skipped: PromotionResult['skipped'];
  overCapacity: boolean;
  targetName?: string;
}

/** The target of a body: all three parts, or none (the final class is completed); a part left out is 400. */
export function targetOf(dto: PromotionTargetDto): Target | null {
  const parts = {
    toAcademicYearId: dto.toAcademicYearId,
    toClassId: dto.toClassId,
    toSectionId: dto.toSectionId,
  };
  const missing = Object.entries(parts).filter(([, value]) => value === null);
  if (missing.length === 3) return null;
  if (missing.length > 0) {
    throw AppException.validation(
      missing.map(([field]) => fieldError(field, FieldErrorCode.REQUIRED)),
    );
  }
  return {
    academicYearId: dto.toAcademicYearId!,
    classId: dto.toClassId!,
    sectionId: dto.toSectionId!,
  };
}

const tooLarge = () => new AppException(HttpStatus.PAYLOAD_TOO_LARGE, ErrorCode.BATCH_TOO_LARGE);

/**
 * STU-09 and PRM-01 (API design 10.7): one student, or a whole class or section, moves to the next academic year. All
 * or nothing in one transaction. The old enrolment ends with its outcome (Promoted, Repeating in the same class,
 * Completed with no target) and its placement on the old year's last day; the new enrolment and placement begin on
 * the new year's first day. A student who holds an enrolment in the target year already is skipped, so a repeat is
 * harmless. Fee accounts are not made here (the Fees phase backfills them).
 */
@Injectable()
export class PromotionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly students: StudentRepository,
    private readonly studentService: StudentService,
    private readonly context: StudentContext,
    private readonly scope: ScopeService,
    private readonly years: AcademicYearDirectory,
    private readonly classes: ClassDirectory,
    private readonly sections: SectionDirectory,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * STU-09: promotes one active student from their open placement. The answer is the profile at the new placement;
   * 409 `ALREADY_ENROLLED` when the student is in a class of the target year already.
   */
  async promoteStudent(
    principal: Principal,
    id: string,
    body: PromoteStudentDto,
  ): Promise<ApiResult<StudentResource>> {
    const to = targetOf(body);
    const context = await this.context.of(principal, id);
    const done = await this.database.transaction(context.tenant, async (tx) => {
      await this.context.lockedActive(tx, id);
      const open = await this.students.openPlacement(tx, id);
      if (!open) throw AppException.businessRule(ErrorCode.NO_CURRENT_PLACEMENT);
      return this.run(
        tx,
        {
          institutionId: context.institutionId,
          personId: principal.personId,
          from: {
            academicYearId: open.academic_year_id,
            classId: open.class_id,
            sectionId: open.section_id,
          },
          to,
          studentIds: [id],
          keepRollNumbers: true,
          rollNumber: body.rollNumber,
          single: true,
        },
        id,
      );
    });
    const profile = (await this.studentService.get(principal, id)) as StudentResource;
    return new ApiResult(profile, {
      status: HttpStatus.OK,
      code: ResultCode.OK,
      meta: done.overCapacity ? warnings(SECTION_OVER_CAPACITY) : null,
    });
  }

  /**
   * PRM-01: promotes the active students placed in a class (or one section) of a year, or the `studentIds` among them
   * (the others are skipped as `NOT_IN_SOURCE`), at most 500. 413 `BATCH_TOO_LARGE`; 422 `TARGET_YEAR_NOT_AFTER_SOURCE`,
   * `YEAR_NOT_ACTIVE`, `SECTION_NOT_IN_CLASS`, `INACTIVE_SECTION`, `NOT_FINAL_CLASS`; 409 `ROLL_NUMBER_TAKEN` (with the
   * student). The same key and body again gives the stored answer.
   */
  async promoteClass(
    principal: Principal,
    key: string | string[] | undefined,
    body: PromoteClassDto,
  ): Promise<ApiResult<PromotionResult>> {
    const to = targetOf(body);
    if ((body.studentIds?.length ?? 0) > MAX_PROMOTED_AT_ONCE) throw tooLarge();
    const context = await this.scope.requireInstitution(principal, body.institutionId);
    return this.idempotency.run(
      {
        tenant: { ...context.tenant, personId: principal.personId },
        key,
        operation: OPERATION,
        request: body,
      },
      async (tx) => {
        const done = await this.run(tx, {
          institutionId: context.institutionId,
          personId: principal.personId,
          from: {
            academicYearId: body.fromAcademicYearId,
            classId: body.fromClassId,
            sectionId: body.fromSectionId,
          },
          to,
          studentIds: body.studentIds,
          keepRollNumbers: body.keepRollNumbers ?? true,
          single: false,
        });
        const count = done.promoted.length;
        const noun = count === 1 ? 'student' : 'students';
        const message =
          done.targetName === undefined
            ? `${count} ${noun} completed the final class`
            : `${count} ${noun} promoted to ${done.targetName}`;
        return {
          result: new ApiResult<PromotionResult>(
            { promotedCount: count, skipped: done.skipped },
            {
              status: HttpStatus.OK,
              code: ResultCode.PROMOTED,
              message,
              meta: done.overCapacity ? warnings(SECTION_OVER_CAPACITY) : null,
            },
          ),
        };
      },
    );
  }

  private async run(tx: Tx, plan: Plan, entityId?: string): Promise<Done> {
    const source = await this.years.openYear(tx, plan.from.academicYearId, plan.institutionId);
    if (!source) throw AppException.notFound();
    const isLast = await this.classes.isLast(tx, plan.from.classId, plan.institutionId);
    if (isLast === undefined) throw AppException.notFound();
    if (plan.from.sectionId !== null) {
      const section = await this.sections.placeOf(tx, plan.from.sectionId);
      if (section?.institutionId !== plan.institutionId) throw AppException.notFound();
      if (section.classId !== plan.from.classId) {
        throw AppException.businessRule(ErrorCode.SECTION_NOT_IN_CLASS);
      }
    }
    const target = plan.to && (await this.requireTarget(tx, plan, source.startDate));
    if (plan.to === null && !isLast) throw AppException.businessRule(ErrorCode.NOT_FINAL_CLASS);

    const rows = await this.students.promotable(tx, {
      academicYearId: plan.from.academicYearId,
      classId: plan.from.classId,
      sectionId: plan.from.sectionId,
      studentIds: plan.studentIds,
    });
    if (rows.length > MAX_PROMOTED_AT_ONCE) throw tooLarge();
    const skipped: PromotionResult['skipped'] = [];
    const found = new Set(rows.map((row) => row.student_id));
    for (const studentId of plan.studentIds ?? []) {
      if (!found.has(studentId)) skipped.push({ studentId, reason: SKIP_NOT_IN_SOURCE });
    }
    const enrolled = plan.to
      ? await this.students.enrolledIn(
          tx,
          plan.to.academicYearId,
          rows.map((row) => row.student_id),
        )
      : new Set<string>();
    if (plan.single && enrolled.size > 0) throw AppException.conflict(ErrorCode.ALREADY_ENROLLED);
    const promoted = rows.filter((row) => !enrolled.has(row.student_id));
    for (const row of rows) {
      if (enrolled.has(row.student_id)) {
        skipped.push({ studentId: row.student_id, reason: SKIP_ALREADY_ENROLLED });
      }
    }

    const rolls = await this.rollNumbers(tx, plan, promoted);
    const outcome = outcomeOf(plan.from.classId, plan.to?.classId ?? null);
    for (const [index, row] of promoted.entries()) {
      await this.students.updatePlacement(tx, row.placement_id, {
        end_date: oldPlacementEnd(row.start_date, source.endDate),
        ...updateStamp(plan.personId),
      });
      await this.students.updateEnrolment(tx, row.enrolment_id, {
        outcome,
        ...updateStamp(plan.personId),
      });
      if (plan.to && target) {
        await this.begin(tx, plan, row, plan.to, target.startDate, rolls[index]!);
      }
    }

    if (promoted.length > 0) {
      await this.audit.record(tx, {
        action: 'student.promoted',
        institutionId: plan.institutionId,
        entityType: 'student',
        entityId,
        after: {
          fromAcademicYearId: plan.from.academicYearId,
          fromClassId: plan.from.classId,
          fromSectionId: plan.from.sectionId,
          toAcademicYearId: plan.to?.academicYearId ?? null,
          toClassId: plan.to?.classId ?? null,
          toSectionId: plan.to?.sectionId ?? null,
          outcome,
          promotedCount: promoted.length,
          skippedCount: skipped.length,
        },
      });
    }
    return {
      promoted,
      skipped,
      overCapacity:
        plan.to && target?.capacity != null
          ? (await this.students.sectionCount(tx, plan.to.academicYearId, plan.to.sectionId)) >
            target.capacity
          : false,
      targetName: target?.name,
    };
  }

  /** The target year (open, and beginning after the source year) and section (open, of the target class). */
  private async requireTarget(
    tx: Tx,
    plan: Plan,
    sourceStart: string,
  ): Promise<{ startDate: string; capacity: number | null; name: string }> {
    const to = plan.to!;
    const year = await this.years.openYear(tx, to.academicYearId, plan.institutionId);
    if (!year) throw AppException.notFound();
    if (!year.open) throw AppException.businessRule(ErrorCode.YEAR_NOT_ACTIVE);
    if (year.startDate <= sourceStart) {
      throw AppException.businessRule(ErrorCode.TARGET_YEAR_NOT_AFTER_SOURCE);
    }
    const section = await this.sections.placeOf(tx, to.sectionId);
    if (section?.institutionId !== plan.institutionId) throw AppException.notFound();
    if (section.classId !== to.classId) {
      throw AppException.businessRule(ErrorCode.SECTION_NOT_IN_CLASS);
    }
    if (!section.active) throw AppException.businessRule(ErrorCode.INACTIVE_SECTION);
    const names = await this.sections.names(tx, [to.sectionId]);
    const named = names.get(to.sectionId);
    return {
      startDate: year.startDate,
      capacity: section.capacity,
      name: named ? `${named.className} ${named.displayName}` : '',
    };
  }

  /** The roll number each promoted student takes in the target section, in the order of `promoted`. */
  private async rollNumbers(
    tx: Tx,
    plan: Plan,
    promoted: readonly PromotableRow[],
  ): Promise<string[]> {
    if (plan.to === null) return [];
    if (plan.rollNumber !== undefined) return promoted.map(() => plan.rollNumber!);
    const old = promoted.map((row) => row.roll_number);
    if (plan.keepRollNumbers) return old;
    return renumber(
      old,
      await this.students.rollNumbersIn(tx, plan.to.academicYearId, plan.to.sectionId),
    );
  }

  /** The new enrolment and its first placement, from the first day of the target year. */
  private async begin(
    tx: Tx,
    plan: Plan,
    row: PromotableRow,
    to: Target,
    start: string,
    rollNumber: string,
  ): Promise<void> {
    const base = {
      society_id: row.society_id,
      institution_id: row.institution_id,
      ...insertStamp(plan.personId),
    };
    try {
      const enrolment = await this.students.insertEnrolment(tx, {
        ...base,
        academic_year_id: to.academicYearId,
        student_id: row.student_id,
        class_id: to.classId,
        enrolled_date: start,
      });
      await this.students.insertPlacement(tx, {
        ...base,
        academic_year_id: to.academicYearId,
        student_enrolment_id: enrolment.id,
        class_id: to.classId,
        section_id: to.sectionId,
        roll_number: rollNumber,
        start_date: start,
      });
    } catch (error) {
      if (isDuplicateOn(error, ROLL_NUMBER)) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.ROLL_NUMBER_TAKEN, {
          details: { studentId: row.student_id },
        });
      }
      throw error;
    }
  }
}
