import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../../platform/audit/index.js';
import { DatabaseService, updateStamp } from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { ScopeService } from '../../platform/tenancy/index.js';
import { DatesheetNotifier } from './datesheet.notifier.js';
import { ExamPaperRepository } from './exam-paper.repository.js';
import { ExamRepository } from './exam.repository.js';
import { examAuditView } from './exam.audit.js';
import { examResource, type ExamResource } from './exam.resource.js';

/**
 * EXM-09 (API design 9.8): publishing an exam's datesheet. A Society Owner and an Institution Admin of the Institution
 * publish; from then on parents read the papers of their child's section, and the sections are told. A paper added,
 * changed or removed afterwards tells them again (EXM-06 to EXM-08), so a datesheet is published once.
 */
@Injectable()
export class DatesheetService {
  constructor(
    private readonly database: DatabaseService,
    private readonly exams: ExamRepository,
    private readonly papers: ExamPaperRepository,
    private readonly scope: ScopeService,
    private readonly notifier: DatesheetNotifier,
    private readonly clock: Clock,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /**
   * 422 `DATESHEET_EMPTY` without an active paper, 409 `DATESHEET_PUBLISHED` once it is out. 404 for an exam that is
   * deactivated or out of reach. Audited `exam.datesheet_published`, and the guardians and staff of its papers are
   * told in the same transaction.
   */
  async publish(principal: Principal, examId: string): Promise<ExamResource> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.exams.find(tx, examId));
    if (!found || found.status === 0) throw AppException.notFound();
    const context = await this.scope.requireInstitution(principal, found.institution_id);
    const row = await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.exams.find(tx, examId, true);
      if (!current || current.status === 0) throw AppException.notFound();
      if (current.datesheet_published_at !== null) {
        throw AppException.conflict(ErrorCode.DATESHEET_PUBLISHED);
      }
      const papers = await this.papers.ofExam(tx, examId);
      if (papers.length === 0) throw AppException.businessRule(ErrorCode.DATESHEET_EMPTY);
      const updated = await this.exams.update(tx, examId, {
        datesheet_published_at: this.clock.now(),
        datesheet_published_by: principal.personId,
        ...updateStamp(principal.personId),
      });
      await this.audit.record(tx, {
        action: 'exam.datesheet_published',
        institutionId: updated.institution_id,
        societyId: updated.society_id,
        entityType: 'exam',
        entityId: updated.id,
        before: examAuditView(current),
        after: examAuditView(updated),
      });
      await this.notifier.published(tx, updated, papers, principal.personId);
      return updated;
    });
    return examResource(row, await this.people.describe(authorIdsOf([row])));
  }
}
