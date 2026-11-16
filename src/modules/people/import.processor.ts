import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { message } from '../../common/i18n/messages.js';
import { isUuid } from '../../common/ids/ids.js';
import { RequestContext } from '../../common/request-context/request-context.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../../platform/audit/index.js';
import { DatabaseService, isDuplicateOn, type Tx } from '../../platform/database/index.js';
import { FileDirectory } from '../../platform/files/index.js';
import {
  JobLeaseLost,
  JobRegistry,
  type ClaimedJob,
  type JobHandler,
  type JobLease,
} from '../../platform/jobs/index.js';
import type { InstitutionContext } from '../../platform/tenancy/index.js';
import { SectionDirectory } from '../academic-setup/index.js';
import { CsvFailure, CsvRejected, readStudentCsv, type CsvRow } from './import.csv.js';
import { ImportRepository, type ImportProgress, type ImportRunRow } from './import.repository.js';
import {
  IMPORT_COUNTRY_CODE,
  IMPORT_RELATION,
  MAX_ROW_ERRORS,
  RunStatus,
  SectionIndex,
  checkRow,
  type ImportedStudent,
  type RowError,
} from './import.rules.js';
import { StudentService, type AddedStudent, type NewStudent } from './student.service.js';

/** The kind of job that settles a student CSV import. */
export const STUDENT_IMPORT_JOB = 'students.import';

/** Rows saved in one transaction, and so the most a restart can ask the worker to redo (SDD 11.2). */
export const IMPORT_BATCH_ROWS = 100;

/** What a run that stopped before the end says (the worker gave up on it). */
export const IMPORT_FAILED = 'IMPORT_FAILED';

const ROLL_NUMBER = 'uq_placements_roll';
const SAVEPOINT = 'import_row';

interface ImportPayload {
  importRunId: string;
  roleCode: number;
}

function payloadOf(job: ClaimedJob): ImportPayload {
  const { importRunId, roleCode } = (job.payload ?? {}) as Partial<ImportPayload>;
  if (!isUuid(importRunId) || typeof roleCode !== 'number') {
    throw new Error('An import job needs an import run and a role');
  }
  return { importRunId, roleCode };
}

/**
 * The worker side of IMP-02 (API design 10.8, SDD 11.2): reads the file, checks each row, and adds the students 100
 * rows to a transaction. A row that breaks a rule is skipped with its reason and never stops the run. The run's
 * progress moves in the transaction of each batch, so a worker that dies resumes after the last batch committed and a
 * student is never added twice. A file that cannot be read at all (a wrong header, too many rows) fails the run with no
 * student added. The people added get the same welcome mail as STU-02 sends, after each batch commits.
 */
@Injectable()
export class ImportProcessor implements JobHandler, OnModuleInit {
  readonly kind = STUDENT_IMPORT_JOB;
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly runs: ImportRepository,
    private readonly students: StudentService,
    private readonly files: FileDirectory,
    private readonly sections: SectionDirectory,
    private readonly audit: AuditService,
    private readonly registry: JobRegistry,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(job: ClaimedJob, lease: JobLease): Promise<void> {
    const { importRunId, roleCode } = payloadOf(job);
    if (job.startedBy === null || job.institutionId === null) {
      throw new Error('An import job needs the person who started it and an Institution');
    }
    const by = job.startedBy;
    const context = this.contextOf(job, by, roleCode);
    await RequestContext.run(
      { requestId: job.id, language: 'en', personId: by, societyId: job.societyId, roleCode },
      async () => {
        const run = await this.database.transaction(context.tenant, (tx) =>
          this.runs.find(tx, importRunId),
        );
        // A run that is settled already (the job was claimed again after the last batch) or swept has nothing left.
        if (run === undefined || run.run_status > RunStatus.Running) return;
        await this.process(run, context, by, lease);
      },
    );
  }

  async fail(job: ClaimedJob, reason: string): Promise<void> {
    this.logger.error({ jobId: job.id, reason }, 'An import stopped for good');
    const { importRunId, roleCode } = payloadOf(job);
    if (job.startedBy === null || job.institutionId === null) return;
    const context = this.contextOf(job, job.startedBy, roleCode);
    await this.database.transaction(context.tenant, (tx) =>
      this.runs.fail(tx, importRunId, { code: IMPORT_FAILED }, this.clock.now()),
    );
  }

  private contextOf(job: ClaimedJob, by: string, roleCode: number): InstitutionContext {
    const institutionId = job.institutionId!;
    return {
      institutionId,
      societyId: job.societyId,
      tenant: { personId: by, societyId: job.societyId, institutionIds: [institutionId], roleCode },
    };
  }

  private async process(
    run: ImportRunRow,
    context: InstitutionContext,
    by: string,
    lease: JobLease,
  ): Promise<void> {
    const content = await this.database.transaction(context.tenant, (tx) =>
      this.files.contentOf(tx, run.file_id),
    );
    let rows: CsvRow[];
    try {
      if (content === null) throw new CsvRejected(CsvFailure.Unreadable);
      rows = readStudentCsv(content);
    } catch (error) {
      if (!(error instanceof CsvRejected)) throw error;
      await this.database.transaction(context.tenant, (tx) =>
        this.runs.fail(tx, run.id, { code: error.code }, this.clock.now()),
      );
      return;
    }
    if (run.run_status === RunStatus.Queued) {
      await this.database.transaction(context.tenant, (tx) =>
        this.runs.start(tx, run.id, rows.length, this.clock.now()),
      );
    }

    let done = run.processed_rows;
    do {
      await lease.keep();
      done = await this.settleBatch(run.id, rows, done, context, by);
    } while (done < rows.length);
  }

  /** Saves the batch that starts after `done` rows and returns how many rows are settled; the last batch completes the run. */
  private async settleBatch(
    runId: string,
    rows: readonly CsvRow[],
    done: number,
    context: InstitutionContext,
    by: string,
  ): Promise<number> {
    const batch = rows.slice(done, done + IMPORT_BATCH_ROWS);
    const added: AddedStudent[] = [];
    const settled = await this.database.transaction(context.tenant, async (tx) => {
      const run = await this.runs.findForUpdate(tx, runId);
      // Another worker has moved the run on since this one claimed it: the lease was lost.
      if (run === undefined || run.run_status > RunStatus.Running || run.processed_rows !== done) {
        throw new JobLeaseLost();
      }
      const index = new SectionIndex(await this.sections.openOf(tx, context.institutionId));
      const progress: ImportProgress = {
        processedRows: done + batch.length,
        importedRows: run.imported_rows,
        skippedRows: run.skipped_rows,
        rowErrors: run.row_errors as RowError[],
        overCapacity: run.over_capacity,
      };
      const errors: RowError[] = [];
      for (const row of batch) {
        const outcome = await this.saveRow(tx, row, index, context, by, run.academic_year_id);
        if ('added' in outcome) {
          added.push(outcome.added);
          progress.importedRows += 1;
          progress.overCapacity ||= outcome.added.overCapacity;
        } else {
          progress.skippedRows += 1;
          errors.push({ row: row.row, message: outcome.message });
        }
      }
      progress.rowErrors = [...progress.rowErrors, ...errors].slice(0, MAX_ROW_ERRORS);
      const finished = progress.processedRows >= rows.length;
      await this.runs.settle(tx, runId, progress, finished ? this.clock.now() : null);
      if (finished) {
        await this.audit.record(tx, {
          action: 'import.finished',
          institutionId: context.institutionId,
          entityType: 'import_run',
          entityId: runId,
          after: { importedRows: progress.importedRows, skippedRows: progress.skippedRows },
        });
      }
      return progress.processedRows;
    });
    for (const student of added) this.students.welcome(student);
    return settled;
  }

  /** One row: skipped with its reason, or added. The row runs under a savepoint so a refusal leaves the batch intact. */
  private async saveRow(
    tx: Tx,
    row: CsvRow,
    index: SectionIndex,
    context: InstitutionContext,
    by: string,
    academicYearId: string,
  ): Promise<{ added: AddedStudent } | { message: string }> {
    const checked = checkRow(row, index);
    if ('message' in checked) return checked;
    await sql`savepoint ${sql.id(SAVEPOINT)}`.execute(tx);
    try {
      const added = await this.students.addWithin(
        tx,
        by,
        context,
        newStudent(checked.student, context.institutionId, academicYearId),
      );
      await sql`release savepoint ${sql.id(SAVEPOINT)}`.execute(tx);
      return { added };
    } catch (error) {
      await sql`rollback to savepoint ${sql.id(SAVEPOINT)}`.execute(tx);
      const problem = rowProblem(error);
      if (problem === null) throw error;
      return { message: problem };
    }
  }
}

/** The body of STU-02 that a row stands for: a student with one primary guardian and no mobile number of their own. */
function newStudent(
  student: ImportedStudent,
  institutionId: string,
  academicYearId: string,
): NewStudent {
  return {
    institutionId,
    firstName: student.firstName,
    lastName: student.lastName,
    mobile: null,
    enrolment: {
      academicYearId,
      classId: student.classId,
      sectionId: student.sectionId,
      rollNumber: student.rollNumber,
    },
    guardians: [
      {
        firstName: student.guardian.firstName,
        lastName: student.guardian.lastName,
        relation: IMPORT_RELATION,
        phone: { countryCode: IMPORT_COUNTRY_CODE, number: student.guardian.phone },
        email: student.guardian.email,
        isPrimary: true,
        isEmergencyContact: true,
      },
    ],
  };
}

/**
 * Why a row that passed its own rules could not be saved, in words for the result; `null` for a fault that is not the
 * row's (the database was lost), which stops the batch and lets the job try again.
 */
export function rowProblem(error: unknown): string | null {
  if (isDuplicateOn(error, ROLL_NUMBER)) return 'RollNumber is already used in this section';
  if (!(error instanceof AppException)) return null;
  switch (error.code) {
    case ErrorCode.ROLE_CONFLICT:
      return 'GuardianEmail belongs to an account that cannot also be a parent';
    case 'ACCOUNT_BLOCKED':
    case ErrorCode.INVALID_STATE:
    case ErrorCode.EMAIL_IN_USE:
      return 'GuardianEmail belongs to an account that cannot be linked';
    case ErrorCode.YEAR_NOT_ACTIVE:
    case ErrorCode.INACTIVE_SECTION:
      return message(error.code);
    default:
      return null;
  }
}
