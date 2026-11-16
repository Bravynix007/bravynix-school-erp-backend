import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, ResultCode } from '../../common/http/error-codes.js';
import { newId } from '../../common/ids/ids.js';
import { pageMeta, pageOffset } from '../../common/pagination/pagination.js';
import { RequestContext } from '../../common/request-context/request-context.js';
import { AuditService } from '../../platform/audit/index.js';
import { DatabaseService, isDuplicateOn } from '../../platform/database/index.js';
import { FileDirectory, FilePurpose } from '../../platform/files/index.js';
import { IdempotencyService } from '../../platform/idempotency/index.js';
import { JobQueue } from '../../platform/jobs/index.js';
import { ScopeService } from '../../platform/tenancy/index.js';
import { AcademicYearDirectory } from '../academic-setup/index.js';
import { sampleCsv } from './import.csv.js';
import type { ListImportsQueryDto, StartImportDto } from './import.dto.js';
import { ImportRepository } from './import.repository.js';
import { importResource, type ImportResource } from './import.resource.js';
import { RunStatus } from './import.rules.js';
import { STUDENT_IMPORT_JOB } from './import.processor.js';

/** The name the idempotency store keeps with a start (API design 14.5). */
const OPERATION = 'imports.start';
const ONE_RUNNING = 'uq_import_runs_running';

/** IMP-02's answer: the run to poll. */
export interface ImportStarted {
  importId: string;
  runStatus: number;
}

/**
 * IMP-01 to IMP-04 (API design 10.8, 16.2): a student CSV import, which the worker settles (`ImportProcessor`). The API
 * only checks the request, records the run and queues the job; the caller polls IMP-03 until the run is Completed or
 * Failed. One run at a time for an Institution.
 */
@Injectable()
export class ImportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly runs: ImportRepository,
    private readonly scope: ScopeService,
    private readonly files: FileDirectory,
    private readonly years: AcademicYearDirectory,
    private readonly idempotency: IdempotencyService,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
  ) {}

  /** IMP-01: the sample file, which shows the header and how a row reads. */
  template(): string {
    return sampleCsv();
  }

  /**
   * IMP-02: records the run and queues it. The file is a Ready one of purpose 12 that the caller uploaded to the
   * Institution (404, 400 `INVALID_VALUE` on `fileId`, 422 `FILE_NOT_READY`); the year is an active year of the
   * Institution (404, 422 `YEAR_NOT_ACTIVE`); 409 `IMPORT_ALREADY_RUNNING` while another run of the Institution is
   * Queued or Running. The file itself is read by the worker: a file that cannot be imported fails the run.
   */
  async start(
    principal: Principal,
    key: string | string[] | undefined,
    body: StartImportDto,
  ): Promise<ApiResult<ImportStarted>> {
    const context = await this.scope.requireInstitution(principal, body.institutionId);
    return this.idempotency.run(
      {
        tenant: { ...context.tenant, personId: principal.personId },
        key,
        operation: OPERATION,
        request: body,
      },
      async (tx) => {
        await this.files.requireUploaded(
          tx,
          body.fileId,
          {
            purpose: FilePurpose.ImportCsv,
            institutionId: context.institutionId,
            uploadedBy: principal.personId,
          },
          'fileId',
        );
        const year = await this.years.openYear(tx, body.academicYearId, context.institutionId);
        if (year === undefined) throw AppException.notFound();
        if (!year.open) throw AppException.businessRule(ErrorCode.YEAR_NOT_ACTIVE);
        const id = newId();
        try {
          await this.runs.insert(tx, {
            id,
            created_by: principal.personId,
            society_id: context.societyId,
            institution_id: context.institutionId,
            file_id: body.fileId,
            academic_year_id: body.academicYearId,
          });
        } catch (error) {
          if (isDuplicateOn(error, ONE_RUNNING)) {
            throw AppException.conflict(ErrorCode.IMPORT_ALREADY_RUNNING);
          }
          throw error;
        }
        await this.queue.enqueue(tx, {
          kind: STUDENT_IMPORT_JOB,
          societyId: context.societyId,
          institutionId: context.institutionId,
          startedBy: principal.personId,
          payload: { importRunId: id, roleCode: principal.roleCode },
        });
        await this.audit.record(tx, {
          action: 'import.started',
          institutionId: context.institutionId,
          entityType: 'import_run',
          entityId: id,
        });
        return {
          result: new ApiResult<ImportStarted>(
            { importId: id, runStatus: RunStatus.Queued },
            {
              status: HttpStatus.ACCEPTED,
              code: ResultCode.ACCEPTED,
              headers: { Location: `/v1/imports/${id}`, 'Retry-After': '2' },
            },
          ),
          resourceId: id,
        };
      },
    );
  }

  /** IMP-03: the run, with its progress and, once it has finished, the rows that were skipped. 404 for another's. */
  async get(principal: Principal, id: string): Promise<ImportResource> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const run = await this.database.transaction(tenant, (tx) => this.runs.find(tx, id));
    if (!run) throw AppException.notFound();
    return importResource(run, RequestContext.current()?.language);
  }

  /** IMP-04: the recent runs of an Institution the caller reaches, newest first (404 for another's). */
  async list(
    principal: Principal,
    query: ListImportsQueryDto,
  ): Promise<ApiResult<ImportResource[]>> {
    const context = await this.scope.requireInstitution(principal, query.institutionId);
    const { rows, total } = await this.database.transaction(context.tenant, (tx) =>
      this.runs.listOf(tx, context.institutionId, {
        limit: query.limit,
        offset: pageOffset(query.page, query.limit),
      }),
    );
    const language = RequestContext.current()?.language;
    return ApiResult.list(
      rows.map((row) => importResource(row, language)),
      pageMeta(query.page, query.limit, total),
    );
  }
}
