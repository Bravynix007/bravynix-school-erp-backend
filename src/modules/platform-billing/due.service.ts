import { Injectable, Logger } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService, type AuditValues } from '../../platform/audit/index.js';
import {
  DatabaseService,
  platformTenant,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import {
  AccountStatus,
  BackgroundMailer,
  GrantDirectory,
  PersonDirectory,
} from '../../platform/identity/index.js';
import { IdempotencyService, wasReplayed } from '../../platform/idempotency/index.js';
import { NumberSequenceService } from '../../platform/numbering/index.js';
import { InstitutionDirectory, type InstitutionRef } from '../../platform/tenancy/index.js';
import { dueRaisedEmail } from './due-email.js';
import {
  DUE_SORT_FIELDS,
  type CancelDueDto,
  type DueQuoteQueryDto,
  type ListDuesQueryDto,
  type MarkDuePaidDto,
  type RaiseDueDto,
  type UpdateDueDto,
} from './due.dto.js';
import { DueRepository, type DueChanges, type DueRow } from './due.repository.js';
import {
  dueResource,
  dueSummary,
  peopleOfDues,
  type DueQuote,
  type DueResource,
  type DueSummary,
} from './due.resource.js';
import {
  STUDENT_COUNT_AUTO,
  DueStatus,
  dueAmounts,
  rateAtPeriodStart,
  requireDue,
  requireNotes,
  requirePaidByToday,
  requirePeriod,
} from './due.rules.js';
import { PriceRateRepository } from './price-rate.repository.js';
import { rateInForce } from './price-rate.rules.js';

/** The name the idempotency store keeps with a raised due (API design 14.5). */
const RAISE_OPERATION = 'billing.raise_due';

function auditView(row: DueRow): AuditValues {
  return {
    invoice_no: row.invoice_no,
    period_start_date: row.period_start_date,
    period_end_date: row.period_end_date,
    student_count_auto: row.student_count_auto,
    student_count: row.student_count,
    student_count_note: row.student_count_note,
    price_rate_id: row.price_rate_id,
    rate_per_student_amount: row.rate_per_student_amount,
    base_amount: row.base_amount,
    adjustment_amount: row.adjustment_amount,
    adjustment_note: row.adjustment_note,
    total_amount: row.total_amount,
    due_date: row.due_date,
    due_status: row.due_status,
    paid_date: row.paid_date,
    payment_mode: row.payment_mode,
    payment_reference: row.payment_reference,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,
  };
}

/**
 * PLT-24 to PLT-30 (PRD 9.3): what BravyNix charges an Institution for a period.
 * Super Admin only. A due freezes the rate, the count and every amount when it
 * is raised, takes its invoice number from the platform counter, and commits
 * with its audit entry. The Society's Owners are emailed once. While it is Due
 * it can be edited; it ends Paid or Cancelled, and neither can be undone.
 */
@Injectable()
export class DueService {
  private readonly logger = new Logger(DueService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly dues: DueRepository,
    private readonly rates: PriceRateRepository,
    private readonly institutions: InstitutionDirectory,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly numbers: NumberSequenceService,
    private readonly grants: GrantDirectory,
    private readonly mailer: BackgroundMailer,
    private readonly clock: Clock,
  ) {}

  /** PLT-24: the count and the rate a due for this period starts from; the rate is null while none applies. */
  async quote(
    principal: Principal,
    institutionId: string,
    query: DueQuoteQueryDto,
  ): Promise<DueQuote> {
    requirePeriod(query.periodStartDate, query.periodEndDate);
    const history = await this.database.transaction(platformTenant(principal), async (tx) => {
      await this.require(tx, institutionId);
      return this.rates.history(tx, institutionId);
    });
    const rate = rateInForce(history, query.periodStartDate);
    return {
      institutionId,
      periodStartDate: query.periodStartDate,
      periodEndDate: query.periodEndDate,
      studentCountAuto: STUDENT_COUNT_AUTO,
      priceRateId: rate?.id ?? null,
      ratePerStudentAmount: rate?.rate_per_student_amount ?? null,
      rateEffectiveFromDate: rate?.effective_from_date ?? null,
      baseAmount: rate
        ? dueAmounts(STUDENT_COUNT_AUTO, rate.rate_per_student_amount, '0.00').baseAmount
        : null,
    };
  }

  /**
   * PLT-26. The rate in force on the first day of the period is copied onto the
   * due. Errors: 422 `NO_RATE_IN_FORCE`, `TOTAL_NEGATIVE` and `NOTE_REQUIRED`;
   * 409 `INVALID_STATE` for an Institution or Society that is no longer active.
   * The same key and body again gives the stored answer and sends no second email.
   */
  async raise(
    principal: Principal,
    key: string | string[] | undefined,
    body: RaiseDueDto,
  ): Promise<ApiResult<DueResource>> {
    requirePeriod(body.periodStartDate, body.periodEndDate);
    // The Society is only known once the Institution is read; the write then
    // opens a transaction that names both, as the audit policy needs.
    const known = await this.database.transaction(platformTenant(principal), (tx) =>
      this.require(tx, body.institutionId),
    );
    const author = await this.people.describe([principal.personId]);
    const tenant = platformTenant(principal, known.societyId, [body.institutionId]);

    const answer = await this.idempotency.run(
      { tenant, key, operation: RAISE_OPERATION, request: body },
      async (tx) => {
        const institution = await this.require(tx, body.institutionId);
        if (!institution.active) throw AppException.conflict(ErrorCode.INVALID_STATE);
        const rate = rateAtPeriodStart(
          await this.rates.history(tx, body.institutionId),
          body.periodStartDate,
        );
        const studentCountNote = body.studentCountNote ?? null;
        const adjustmentAmount = body.adjustmentAmount ?? '0.00';
        const adjustmentNote = body.adjustmentNote ?? null;
        requireNotes({
          studentCount: body.studentCount,
          studentCountAuto: STUDENT_COUNT_AUTO,
          studentCountNote,
          adjustmentAmount,
          adjustmentNote,
        });
        const amounts = dueAmounts(
          body.studentCount,
          rate.rate_per_student_amount,
          adjustmentAmount,
        );
        const row = await this.dues.insert(tx, {
          society_id: institution.societyId,
          institution_id: institution.id,
          invoice_no: await this.numbers.nextPlatformInvoice(tx, this.clock.todayIst()),
          period_start_date: body.periodStartDate,
          period_end_date: body.periodEndDate,
          student_count_auto: STUDENT_COUNT_AUTO,
          student_count: body.studentCount,
          student_count_note: studentCountNote,
          price_rate_id: rate.id,
          rate_per_student_amount: rate.rate_per_student_amount,
          base_amount: amounts.baseAmount,
          adjustment_amount: adjustmentAmount,
          adjustment_note: adjustmentNote,
          total_amount: amounts.totalAmount,
          due_date: body.dueDate ?? null,
          created_by: principal.personId,
          updated_by: principal.personId,
        });
        await this.audit.record(tx, {
          action: 'platform_due.raise',
          societyId: row.society_id,
          institutionId: row.institution_id,
          entityType: 'platform_due',
          entityId: row.id,
          after: auditView(row),
        });
        const names = await this.institutions.names(tx, [row.institution_id]);
        return { result: ApiResult.created(dueResource(row, names, author)), resourceId: row.id };
      },
    );
    if (!wasReplayed(answer)) await this.notifyOwners(known.societyId, answer.data);
    return answer;
  }

  /** PLT-25: dues across Societies, newest first unless sorted. */
  async list(principal: Principal, query: ListDuesQueryDto): Promise<ApiResult<DueSummary[]>> {
    const sort = parseSort(query.sort, DUE_SORT_FIELDS, [
      { field: 'createdAt', direction: 'desc' },
    ]);
    return this.database.transaction(platformTenant(principal), async (tx) => {
      const { rows, total } = await this.dues.page(
        tx,
        {
          q: query.q,
          societyId: query.societyId,
          institutionId: query.institutionId,
          statuses: query.dueStatus,
        },
        sort,
        query.limit,
        pageOffset(query.page, query.limit),
      );
      const names = await this.institutions.names(tx, [
        ...new Set(rows.map((row) => row.institution_id)),
      ]);
      return ApiResult.list(
        rows.map((row) => dueSummary(row, names)),
        pageMeta(query.page, query.limit, total),
      );
    });
  }

  /** PLT-27: 404 for an unknown due. */
  async get(principal: Principal, dueId: string): Promise<DueResource> {
    const { row, names } = await this.database.transaction(
      platformTenant(principal),
      async (tx) => {
        const found = await this.mustFind(tx, dueId);
        return { row: found, names: await this.namesOf(tx, found) };
      },
    );
    return dueResource(row, names, await this.people.describe(peopleOfDues([row])));
  }

  /**
   * PLT-28: any of the fields of a raise except the Institution, for a due that is still Due. The count,
   * adjustment and notes are checked and the totals worked out again as when raising. A new `periodStartDate`
   * takes the rate in force on that day (422 `NO_RATE_IN_FORCE` if none); otherwise the frozen rate stays. A
   * request that changes nothing writes nothing: no new version, no audit entry.
   */
  async edit(principal: Principal, dueId: string, body: UpdateDueDto): Promise<DueResource> {
    return this.change(principal, dueId, body.version, async (tx, current) => {
      const next = {
        periodStartDate: body.periodStartDate ?? current.period_start_date,
        periodEndDate: body.periodEndDate ?? current.period_end_date,
        studentCount: body.studentCount ?? current.student_count,
        studentCountNote:
          body.studentCountNote === undefined ? current.student_count_note : body.studentCountNote,
        adjustmentAmount: body.adjustmentAmount ?? current.adjustment_amount,
        adjustmentNote:
          body.adjustmentNote === undefined ? current.adjustment_note : body.adjustmentNote,
        dueDate: body.dueDate === undefined ? current.due_date : body.dueDate,
      };
      requirePeriod(next.periodStartDate, next.periodEndDate);
      const rate =
        next.periodStartDate === current.period_start_date
          ? { id: current.price_rate_id, rate_per_student_amount: current.rate_per_student_amount }
          : rateAtPeriodStart(
              await this.rates.history(tx, current.institution_id),
              next.periodStartDate,
            );
      requireNotes({
        studentCount: next.studentCount,
        studentCountAuto: current.student_count_auto,
        studentCountNote: next.studentCountNote,
        adjustmentAmount: next.adjustmentAmount,
        adjustmentNote: next.adjustmentNote,
      });
      const amounts = dueAmounts(
        next.studentCount,
        rate.rate_per_student_amount,
        next.adjustmentAmount,
      );
      const changes: DueChanges = {
        period_start_date: next.periodStartDate,
        period_end_date: next.periodEndDate,
        student_count: next.studentCount,
        student_count_note: next.studentCountNote,
        price_rate_id: rate.id,
        rate_per_student_amount: rate.rate_per_student_amount,
        base_amount: amounts.baseAmount,
        adjustment_amount: next.adjustmentAmount,
        adjustment_note: next.adjustmentNote,
        total_amount: amounts.totalAmount,
        due_date: next.dueDate,
      };
      const differs = Object.entries(changes).some(
        ([column, value]) => current[column as keyof DueRow] !== value,
      );
      return differs ? { action: 'platform_due.edit', changes } : undefined;
    });
  }

  /**
   * PLT-29: the money arrived. The paid date is today in India or earlier (400 on `paidDate`); the due must
   * still be Due (409 `INVALID_STATE`), and Paid cannot be undone.
   */
  async markPaid(principal: Principal, dueId: string, body: MarkDuePaidDto): Promise<DueResource> {
    return this.change(principal, dueId, body.version, (_tx, _current) => {
      requirePaidByToday(body.paidDate, this.clock.todayIst());
      return {
        action: 'platform_due.mark_paid',
        changes: {
          due_status: DueStatus.Paid,
          paid_date: body.paidDate,
          payment_mode: body.paymentMode,
          payment_reference: body.paymentReference ?? null,
        },
      };
    });
  }

  /** PLT-30: the due is withdrawn, with the reason kept. The row stays; only a due that is still Due can be cancelled. */
  async cancel(principal: Principal, dueId: string, body: CancelDueDto): Promise<DueResource> {
    return this.change(principal, dueId, body.version, () => ({
      action: 'platform_due.cancel',
      changes: {
        due_status: DueStatus.Cancelled,
        cancelled_at: this.clock.now(),
        cancelled_by: principal.personId,
        cancel_reason: body.reason,
      },
    }));
  }

  /**
   * The shape of PLT-28 to PLT-30: the due is found (404), locked and checked against the `version` the client
   * read (409 `VERSION_CONFLICT`, before anything else) and must still be Due (409 `INVALID_STATE`). `decide`
   * says what to write, or nothing; the write, the audit entry and the new version commit together.
   */
  private async change(
    principal: Principal,
    dueId: string,
    version: number,
    decide: (
      tx: Tx,
      current: DueRow,
    ) =>
      | { action: string; changes: DueChanges }
      | undefined
      | Promise<{ action: string; changes: DueChanges } | undefined>,
  ): Promise<DueResource> {
    // The Society and Institution are only known once the due is read; the write then
    // opens a transaction that names both, as the audit policy needs.
    const known = await this.database.transaction(platformTenant(principal), (tx) =>
      this.mustFind(tx, dueId),
    );
    const tenant = platformTenant(principal, known.society_id, [known.institution_id]);
    const { row, names } = await this.database.transaction(tenant, async (tx) => {
      const current = await this.mustFind(tx, dueId, true);
      requireVersion(current, version);
      requireDue(current.due_status);
      const decision = await decide(tx, current);
      if (!decision) return { row: current, names: await this.namesOf(tx, current) };
      await this.dues.update(tx, dueId, {
        ...decision.changes,
        ...updateStamp(principal.personId),
      });
      const updated = await this.mustFind(tx, dueId);
      await this.audit.record(tx, {
        action: decision.action,
        societyId: updated.society_id,
        institutionId: updated.institution_id,
        entityType: 'platform_due',
        entityId: dueId,
        before: auditView(current),
        after: auditView(updated),
      });
      return { row: updated, names: await this.namesOf(tx, updated) };
    });
    return dueResource(row, names, await this.people.describe(peopleOfDues([row])));
  }

  private namesOf(tx: Tx, row: DueRow) {
    return this.institutions.names(tx, [row.institution_id]);
  }

  private async mustFind(tx: Tx, dueId: string, lock = false): Promise<DueRow> {
    const found = await this.dues.find(tx, dueId, lock);
    if (!found) throw AppException.notFound();
    return found;
  }

  /** 404 for an unknown Institution. */
  private async require(tx: Tx, institutionId: string): Promise<InstitutionRef> {
    const institution = await this.institutions.find(tx, institutionId);
    if (!institution) throw AppException.notFound();
    return institution;
  }

  /**
   * Tells each Owner who can still sign in (PRD 10). The due is already saved, so
   * a failure here is logged and never changes the answer; a retry queue arrives
   * with the Jobs module.
   */
  private async notifyOwners(societyId: string, due: DueResource): Promise<void> {
    try {
      const owners = await this.grants.societyOwners(societyId);
      for (const owner of owners) {
        if (owner.accountStatus === AccountStatus.Active) {
          this.mailer.send(dueRaisedEmail(owner.email, due));
        }
      }
    } catch (error) {
      this.logger.warn({ msg: 'Owners were not told of a due', dueId: due.id, err: error });
    }
  }
}
