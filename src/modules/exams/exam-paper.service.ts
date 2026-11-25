import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { requireVersion } from '../../common/http/require-version.js';
import { newId } from '../../common/ids/ids.js';
import { clockOf, requireTimes } from '../../common/validation/clock-time.js';
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
import { SectionDirectory, StaffDirectory, SubjectDirectory } from '../academic-setup/index.js';
import type {
  CreateExamPaperDto,
  ListExamPapersQueryDto,
  UpdateExamPaperDto,
} from './exam-paper.dto.js';
import {
  ExamPaperRepository,
  type ExamPaperChanges,
  type ExamPaperRow,
} from './exam-paper.repository.js';
import {
  examPaperResource,
  type ExamPaperResource,
  type PaperNames,
} from './exam-paper.resource.js';
import {
  marksOf,
  requireExamDate,
  requirePassingMarks,
  translatePaperError,
} from './exam-paper.rules.js';
import { ExamPeople } from './exam-people.js';
import { ExamRepository, type ExamRow } from './exam.repository.js';

/** What the audit log keeps of a paper. */
function auditView(row: ExamPaperRow): AuditValues {
  return {
    exam_id: row.exam_id,
    section_id: row.section_id,
    subject_id: row.subject_id,
    exam_date: row.exam_date,
    start_time: clockOf(row.start_time),
    end_time: clockOf(row.end_time),
    room_name: row.room_name,
    max_marks: row.max_marks,
    passing_marks: row.passing_marks,
    subject_teacher_staff_member_id: row.subject_teacher_staff_member_id,
    invigilator_staff_member_id: row.invigilator_staff_member_id,
    status: row.status,
  };
}

/**
 * EXM-05 to EXM-08 (API design 9.8): the papers of an exam, its datesheet. A Society Owner and an Institution Admin of
 * the Institution add, change and remove them; everyone in its scope reads, and a parent reads their child's section
 * once the datesheet is published. The database refuses a paper that clashes with another, whoever saves first.
 */
@Injectable()
export class ExamPaperService {
  constructor(
    private readonly database: DatabaseService,
    private readonly papers: ExamPaperRepository,
    private readonly exams: ExamRepository,
    private readonly scope: ScopeService,
    private readonly children: ChildContexts,
    private readonly sections: SectionDirectory,
    private readonly subjects: SubjectDirectory,
    private readonly staff: StaffDirectory,
    private readonly examPeople: ExamPeople,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /**
   * EXM-05: the active papers of an exam in the order they are sat, one section's when `sectionId` is named. A parent
   * names their child instead and reads that child's section, and gets none until the datesheet is published (the
   * exam itself says when); 404 for an exam of another Institution than the child's.
   */
  async list(
    principal: Principal,
    examId: string,
    query: ListExamPapersQueryDto,
  ): Promise<ApiResult<ExamPaperResource[]>> {
    const parent = principal.roleCode === RoleCode.StudentParent;
    const context = await this.readContext(principal, examId, query);
    const { rows, names } = await this.database.transaction(context.tenant, async (tx) => {
      await this.requireExamOf(tx, examId, context.institutionId);
      const found = await this.papers.ofExam(tx, examId, query.sectionId);
      return { rows: found, names: await this.namesOf(tx, found, parent) };
    });
    return ApiResult.list(await this.resources(rows, names, parent), null);
  }

  /**
   * EXM-06: a paper of the exam for a section and a subject. 400 `OUT_OF_RANGE` on a day the exam does not run, an end
   * not after the start or passing marks above the maximum; 404 and 422 for a section, subject or staff member that is
   * not usable; 409 `DUPLICATE` on `subjectId`, `PAPER_OVERLAP`, `INVIGILATOR_DOUBLE_BOOKED` and `ROOM_TAKEN`.
   */
  async create(
    principal: Principal,
    examId: string,
    body: CreateExamPaperDto,
  ): Promise<ExamPaperResource> {
    const context = await this.contextOfExam(principal, examId);
    const marks = marksOf(body.maxMarks, body.passingMarks);
    requireTimes(body.startTime, body.endTime);
    requirePassingMarks(marks.maxMarks, marks.passingMarks);
    const { row, names } = await this.database
      .transaction(context.tenant, async (tx) => {
        const exam = await this.lockedExam(tx, examId);
        requireExamDate(body.examDate, { startDate: exam.start_date, endDate: exam.end_date });
        await this.requireUsableSection(tx, body.sectionId, exam.institution_id);
        await this.subjects.requireActive(tx, [body.subjectId], 'subjectId');
        await this.requirePeople(tx, exam.institution_id, {
          subjectId: body.subjectId,
          teacherId: body.subjectTeacherStaffMemberId ?? null,
          invigilatorId: body.invigilatorStaffMemberId ?? null,
        });
        const created = await this.papers.insert(tx, {
          id: newId(),
          society_id: exam.society_id,
          institution_id: exam.institution_id,
          academic_year_id: exam.academic_year_id,
          exam_id: exam.id,
          section_id: body.sectionId,
          subject_id: body.subjectId,
          exam_date: body.examDate,
          start_time: body.startTime,
          end_time: body.endTime,
          room_name: body.roomName ?? null,
          max_marks: marks.maxMarks,
          passing_marks: marks.passingMarks,
          subject_teacher_staff_member_id: body.subjectTeacherStaffMemberId ?? null,
          invigilator_staff_member_id: body.invigilatorStaffMemberId ?? null,
          ...insertStamp(principal.personId),
        });
        await this.record(tx, 'exam_paper.created', created, { after: auditView(created) });
        return { row: created, names: await this.namesOf(tx, [created], false) };
      })
      .catch((error: unknown) => {
        throw translatePaperError(error);
      });
    return this.one(row, names);
  }

  /**
   * EXM-07: the day, the times, the room, the marks and the people; the exam, the section and the subject stay. The
   * same refusals as EXM-06 on what the request changes (a teacher or an invigilator who has since left does not stop
   * the change of a room). A request that changes nothing writes nothing; a removed paper is 404.
   */
  async update(
    principal: Principal,
    id: string,
    body: UpdateExamPaperDto,
  ): Promise<ExamPaperResource> {
    const context = await this.contextOfPaper(principal, id);
    const { row, names } = await this.database
      .transaction(context.tenant, async (tx) => {
        const { paper: current, exam } = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        const changes = changedColumns(
          {
            ...current,
            start_time: clockOf(current.start_time),
            end_time: clockOf(current.end_time),
          },
          {
            exam_date: body.examDate,
            start_time: body.startTime,
            end_time: body.endTime,
            room_name: body.roomName,
            max_marks: body.maxMarks,
            passing_marks: body.passingMarks,
            subject_teacher_staff_member_id: body.subjectTeacherStaffMemberId,
            invigilator_staff_member_id: body.invigilatorStaffMemberId,
          },
        ) as ExamPaperChanges;
        if (Object.keys(changes).length === 0) {
          return { row: current, names: await this.namesOf(tx, [current], false) };
        }
        if (changes.exam_date !== undefined) {
          requireExamDate(changes.exam_date, {
            startDate: exam.start_date,
            endDate: exam.end_date,
          });
        }
        if (changes.start_time !== undefined || changes.end_time !== undefined) {
          requireTimes(
            changes.start_time ?? clockOf(current.start_time),
            changes.end_time ?? clockOf(current.end_time),
          );
        }
        if (changes.max_marks !== undefined || changes.passing_marks !== undefined) {
          requirePassingMarks(
            changes.max_marks ?? current.max_marks,
            changes.passing_marks ?? current.passing_marks,
          );
        }
        await this.requirePeople(tx, current.institution_id, {
          subjectId: current.subject_id,
          teacherId: changes.subject_teacher_staff_member_id ?? null,
          invigilatorId: changes.invigilator_staff_member_id ?? null,
        });
        const updated = await this.papers.update(tx, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        await this.record(tx, 'exam_paper.updated', updated, {
          before: auditView(current),
          after: auditView(updated),
        });
        return { row: updated, names: await this.namesOf(tx, [updated], false) };
      })
      .catch((error: unknown) => {
        throw translatePaperError(error);
      });
    return this.one(row, names);
  }

  /** EXM-08: removes the paper: `status` 0, and its section, time and room are free again. Nothing is deleted. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOfPaper(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const { paper: current } = await this.lockedActive(tx, id);
      const updated = await this.papers.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'exam_paper.deactivated', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /**
   * Whose Institution a read is for. A parent names their child (400 `REQUIRED` without) and may name no section;
   * everyone else has no child to name and reads the exam's Institution, which they must reach (404 otherwise).
   */
  private async readContext(
    principal: Principal,
    examId: string,
    query: ListExamPapersQueryDto,
  ): Promise<InstitutionContext> {
    if (principal.roleCode === RoleCode.StudentParent) {
      const errors = parentReadErrors(query, ['sectionId']);
      if (errors.length > 0) throw AppException.validation(errors);
      return this.children.of(principal, query.studentId!);
    }
    const errors = staffReadErrors(query);
    if (errors.length > 0) throw AppException.validation(errors);
    return this.contextOfExam(principal, examId);
  }

  /** The active exam, which must belong to the Institution the caller reads (404 otherwise, and when deactivated). */
  private async requireExamOf(tx: Tx, examId: string, institutionId: string): Promise<void> {
    const exam = await this.exams.find(tx, examId);
    if (!exam || exam.status === 0 || exam.institution_id !== institutionId) {
      throw AppException.notFound();
    }
  }

  /** The section is of the exam's Institution (404 for any other) and active (422 `REFERENCE_INACTIVE`). */
  private async requireUsableSection(
    tx: Tx,
    sectionId: string,
    institutionId: string,
  ): Promise<void> {
    const place = await this.sections.placeOf(tx, sectionId);
    if (!place || place.institutionId !== institutionId) throw AppException.notFound();
    if (!place.active) throw AppException.referenceInactive('sectionId');
  }

  /** A teacher who teaches the subject and an invigilator, each only when named, each of the Institution. */
  private async requirePeople(
    tx: Tx,
    institutionId: string,
    named: { subjectId: string; teacherId: string | null; invigilatorId: string | null },
  ): Promise<void> {
    if (named.teacherId !== null) {
      await this.examPeople.requireSubjectTeacher(
        tx,
        named.teacherId,
        institutionId,
        named.subjectId,
        'subjectTeacherStaffMemberId',
      );
    }
    if (named.invigilatorId !== null) {
      await this.examPeople.requireInvigilator(
        tx,
        named.invigilatorId,
        institutionId,
        'invigilatorStaffMemberId',
      );
    }
  }

  /** The names of the subjects, staff and (except for a parent, who has no such names) sections of these papers. */
  private async namesOf(
    tx: Tx,
    rows: readonly ExamPaperRow[],
    parent: boolean,
  ): Promise<PaperNames> {
    const staffIds = [
      ...new Set(
        rows.flatMap((row) =>
          [row.subject_teacher_staff_member_id, row.invigilator_staff_member_id].filter(
            (id): id is string => id !== null,
          ),
        ),
      ),
    ];
    return {
      subjects: await this.subjects.names(tx, [...new Set(rows.map((row) => row.subject_id))]),
      staff: parent ? new Map() : await this.staff.names(tx, staffIds),
      sections: parent
        ? new Map()
        : await this.sections.names(tx, [...new Set(rows.map((row) => row.section_id))]),
    };
  }

  private async resources(
    rows: readonly ExamPaperRow[],
    names: PaperNames,
    parent: boolean,
  ): Promise<ExamPaperResource[]> {
    const people = await this.people.describe(authorIdsOf(rows));
    return rows.map((row) => examPaperResource(row, names, people, parent));
  }

  private async one(row: ExamPaperRow, names: PaperNames): Promise<ExamPaperResource> {
    return (await this.resources([row], names, false))[0]!;
  }

  /** The Institution of an exam named by its ID alone, which the caller must reach (404 otherwise, and when deactivated). */
  private async contextOfExam(principal: Principal, examId: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.exams.find(tx, examId));
    if (!found || found.status === 0) throw AppException.notFound();
    return this.scope.requireInstitution(principal, found.institution_id);
  }

  /** The Institution of a paper named by its ID alone, which the caller must reach (404 otherwise, and when removed). */
  private async contextOfPaper(principal: Principal, id: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.papers.find(tx, id));
    if (!found || found.status === 0) throw AppException.notFound();
    return this.scope.requireInstitution(principal, found.institution_id);
  }

  /** The active exam, held so that its dates cannot change while a paper is added (EXM-03 holds it the same way). */
  private async lockedExam(tx: Tx, examId: string): Promise<ExamRow> {
    const exam = await this.exams.find(tx, examId, true);
    if (!exam || exam.status === 0) throw AppException.notFound();
    return exam;
  }

  /** The active paper and its exam, both held: the exam first, as EXM-06 does, so two writers never wait on each other. */
  private async lockedActive(tx: Tx, id: string): Promise<{ paper: ExamPaperRow; exam: ExamRow }> {
    const unlocked = await this.papers.find(tx, id);
    if (!unlocked) throw AppException.notFound();
    const exam = await this.lockedExam(tx, unlocked.exam_id);
    const paper = await this.papers.find(tx, id, true);
    if (!paper || paper.status === 0) throw AppException.notFound();
    return { paper, exam };
  }

  /** The paper carries the Society and the Institution, so the Society's Owners see it (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    paper: ExamPaperRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: paper.institution_id,
      societyId: paper.society_id,
      entityType: 'exam_paper',
      entityId: paper.id,
      ...values,
    });
  }
}
