import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { newId } from '../../common/ids/ids.js';
import { fieldError } from '../../common/validation/field-error.js';
import { parentReadErrors, staffReadErrors } from '../../common/validation/parent-read.js';
import { AuditService, type AuditValues } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import {
  ChildContexts,
  ScopeService,
  type InstitutionContext,
} from '../../platform/tenancy/index.js';
import { AcademicYearDirectory, type YearSpan } from '../academic-setup/index.js';
import type { CreateExamDto, ListExamsQueryDto, UpdateExamDto } from './exam.dto.js';
import { ExamPaperRepository } from './exam-paper.repository.js';
import { ExamRepository, type ExamChanges, type ExamRow } from './exam.repository.js';
import { examResource, type ExamResource } from './exam.resource.js';
import { requireDates, translateExamError } from './exam.rules.js';

/** What the audit log keeps of an exam. */
function auditView(row: ExamRow): AuditValues {
  return {
    academic_year_id: row.academic_year_id,
    name: row.name,
    exam_type: row.exam_type,
    start_date: row.start_date,
    end_date: row.end_date,
    status: row.status,
  };
}

/**
 * EXM-01 to EXM-04 (API design 9.8): the exams of one Institution's academic year. A Society Owner and an Institution
 * Admin of the Institution add, change and deactivate; everyone in its scope reads, and a parent reads their child's
 * Institution. The database refuses a repeated name, whoever saves first.
 */
@Injectable()
export class ExamService {
  constructor(
    private readonly database: DatabaseService,
    private readonly exams: ExamRepository,
    private readonly papers: ExamPaperRepository,
    private readonly scope: ScopeService,
    private readonly years: AcademicYearDirectory,
    private readonly children: ChildContexts,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /**
   * EXM-01: the active exams of a year, the earliest first. The year is the one named, or the Institution's current
   * year (422 `CURRENT_YEAR_REQUIRED` when it has none). A parent names their child, and reads the current year of the
   * child's Institution.
   */
  async list(principal: Principal, query: ListExamsQueryDto): Promise<ApiResult<ExamResource[]>> {
    const context = await this.readContext(principal, query);
    const rows = await this.database.transaction(context.tenant, async (tx) => {
      const yearId =
        query.academicYearId === undefined
          ? await this.years.requireCurrentId(tx, context.institutionId)
          : await this.namedYear(tx, query.academicYearId, context.institutionId);
      return this.exams.active(tx, yearId);
    });
    const people = await this.people.describe(authorIdsOf(rows));
    return ApiResult.list(
      rows.map((row) => examResource(row, people)),
      null,
    );
  }

  /**
   * EXM-02: 409 `DUPLICATE` on `name`, 400 `OUT_OF_RANGE` on a date that is not inside the year or an end before the
   * start. The exam joins the year named, which must be active, or the current year.
   */
  async create(principal: Principal, body: CreateExamDto): Promise<ExamResource> {
    const context = await this.scope.requireInstitution(principal, body.institutionId);
    const row = await this.database
      .transaction(context.tenant, async (tx) => {
        const yearId =
          body.academicYearId === undefined
            ? await this.years.requireCurrentId(tx, context.institutionId)
            : await this.openYear(tx, body.academicYearId, context.institutionId);
        requireDates(body.startDate, body.endDate, await this.spanOf(tx, yearId, context));
        const created = await this.exams.insert(tx, {
          id: newId(),
          society_id: context.societyId,
          institution_id: context.institutionId,
          academic_year_id: yearId,
          name: body.name,
          exam_type: body.examType,
          start_date: body.startDate,
          end_date: body.endDate,
          ...insertStamp(principal.personId),
        });
        await this.record(tx, 'exam.created', created, { after: auditView(created) });
        return created;
      })
      .catch((error: unknown) => {
        throw translateExamError(error);
      });
    return this.resource(row);
  }

  /**
   * EXM-03: a request that changes nothing writes nothing. A deactivated exam is 404. Dates that leave an active paper
   * outside them are 409 `PAPER_OUTSIDE_EXAM`: move or remove the paper first.
   */
  async update(principal: Principal, id: string, body: UpdateExamDto): Promise<ExamResource> {
    const context = await this.contextOf(principal, id);
    const row = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        const wanted: ExamChanges = {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.examType === undefined ? {} : { exam_type: body.examType }),
          ...(body.startDate === undefined ? {} : { start_date: body.startDate }),
          ...(body.endDate === undefined ? {} : { end_date: body.endDate }),
        };
        const changes = changedColumns(current, wanted) as ExamChanges;
        if (Object.keys(changes).length === 0) return current;
        // The dates are checked only when one changes: a year may have been shortened since, and the rename of an exam
        // must not be refused for dates the caller did not touch.
        if (changes.start_date !== undefined || changes.end_date !== undefined) {
          const startDate = changes.start_date ?? current.start_date;
          const endDate = changes.end_date ?? current.end_date;
          requireDates(
            startDate,
            endDate,
            await this.spanOf(tx, current.academic_year_id, context),
          );
          if (await this.papers.anyOutside(tx, id, startDate, endDate)) {
            throw AppException.conflict(ErrorCode.PAPER_OUTSIDE_EXAM);
          }
        }
        const updated = await this.exams.update(tx, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        await this.record(tx, 'exam.updated', updated, {
          before: auditView(current),
          after: auditView(updated),
        });
        return updated;
      })
      .catch((error: unknown) => {
        throw translateExamError(error);
      });
    return this.resource(row);
  }

  /** EXM-04: deactivates the exam, and its name is free again. Nothing is deleted. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOf(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      const updated = await this.exams.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'exam.deactivated', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /**
   * Whose Institution a read is for. A parent names their child (400 `REQUIRED` without), and may not name an
   * Institution or a year; everyone else names the Institution (400 `REQUIRED` without) and has no child to name.
   */
  private async readContext(
    principal: Principal,
    query: ListExamsQueryDto,
  ): Promise<InstitutionContext> {
    if (principal.roleCode === RoleCode.StudentParent) {
      const errors = parentReadErrors(query, ['institutionId', 'academicYearId']);
      if (errors.length > 0) throw AppException.validation(errors);
      return this.children.of(principal, query.studentId!);
    }
    const errors = [
      ...(query.institutionId === undefined
        ? [fieldError('institutionId', FieldErrorCode.REQUIRED)]
        : []),
      ...staffReadErrors(query),
    ];
    if (errors.length > 0) throw AppException.validation(errors);
    return this.scope.requireInstitution(principal, query.institutionId!);
  }

  /** A year of the Institution, open or not, to read; 404 for any other. */
  private async namedYear(tx: Tx, yearId: string, institutionId: string): Promise<string> {
    if ((await this.years.openYear(tx, yearId, institutionId)) === undefined) {
      throw AppException.notFound();
    }
    return yearId;
  }

  /** A year of the Institution to add to: 404 for any other, 422 `REFERENCE_INACTIVE` when it is deactivated. */
  private async openYear(tx: Tx, yearId: string, institutionId: string): Promise<string> {
    await this.years.requireActive(tx, yearId, institutionId, 'academicYearId');
    return yearId;
  }

  /** The first and last day of an exam's year, which the caller reaches because it reaches the exam's Institution. */
  private async spanOf(tx: Tx, yearId: string, context: InstitutionContext): Promise<YearSpan> {
    const year = await this.years.openYear(tx, yearId, context.institutionId);
    if (year === undefined) throw AppException.notFound();
    return year;
  }

  /** The Institution of an exam named by its ID alone, which the caller must reach (404 otherwise, and when deactivated). */
  private async contextOf(principal: Principal, id: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.exams.find(tx, id));
    if (!found || found.status === 0) throw AppException.notFound();
    return this.scope.requireInstitution(principal, found.institution_id);
  }

  private async lockedActive(tx: Tx, id: string): Promise<ExamRow> {
    const exam = await this.exams.find(tx, id, true);
    if (!exam || exam.status === 0) throw AppException.notFound();
    return exam;
  }

  private async resource(row: ExamRow): Promise<ExamResource> {
    return examResource(row, await this.people.describe(authorIdsOf([row])));
  }

  /** The entry carries the Society and the Institution, so the Society's Owners see it (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    exam: ExamRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: exam.institution_id,
      societyId: exam.society_id,
      entityType: 'exam',
      entityId: exam.id,
      ...values,
    });
  }
}
