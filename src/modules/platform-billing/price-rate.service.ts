import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService, type AuditValues } from '../../platform/audit/index.js';
import {
  DatabaseService,
  duplicateOn,
  isDuplicateOn,
  platformTenant,
  type Tx,
} from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { InstitutionDirectory, type InstitutionRef } from '../../platform/tenancy/index.js';
import type { SetPriceRateDto } from './price-rate.dto.js';
import { rateInForce } from './price-rate.rules.js';
import { PriceRateRepository, type PriceRateRow } from './price-rate.repository.js';
import {
  peopleOfRates,
  priceRateResource,
  priceRateResources,
  type PriceRateResource,
} from './price-rate.resource.js';

function auditView(row: PriceRateRow): AuditValues {
  return {
    rate_per_student_amount: row.rate_per_student_amount,
    effective_from_date: row.effective_from_date,
    note: row.note,
  };
}

/**
 * PLT-22 and PLT-23 (PRD 9.2): the rate history of an Institution and a new
 * rate. Super Admin only; a rate is only ever added, and each one commits with
 * its audit entry.
 */
@Injectable()
export class PriceRateService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rates: PriceRateRepository,
    private readonly institutions: InstitutionDirectory,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** PLT-22: every rate, the latest start first, with the one in force today marked. */
  async history(
    principal: Principal,
    institutionId: string,
  ): Promise<ApiResult<PriceRateResource[]>> {
    const rows = await this.database.transaction(platformTenant(principal), async (tx) => {
      await this.require(tx, institutionId);
      return this.rates.history(tx, institutionId);
    });
    const people = await this.people.describe(peopleOfRates(rows));
    return ApiResult.list(priceRateResources(rows, this.clock.todayIst(), people), null);
  }

  /**
   * PLT-23: one rate per effective date, so a second for the same date is 409
   * `DUPLICATE`. A deactivated Institution or Society takes no new rate, 409
   * `INVALID_STATE`.
   */
  async set(
    principal: Principal,
    institutionId: string,
    body: SetPriceRateDto,
  ): Promise<PriceRateResource> {
    // The Society is only known once the Institution is read; the write then
    // opens a transaction that names both, as the audit policy needs.
    const known = await this.database.transaction(platformTenant(principal), (tx) =>
      this.require(tx, institutionId),
    );
    const tenant = platformTenant(principal, known.societyId, [institutionId]);
    const { row, history } = await this.database
      .transaction(tenant, async (tx) => {
        const institution = await this.require(tx, institutionId);
        if (!institution.active) throw AppException.conflict(ErrorCode.INVALID_STATE);
        const created = await this.rates.insert(tx, {
          society_id: institution.societyId,
          institution_id: institutionId,
          rate_per_student_amount: body.ratePerStudentAmount,
          effective_from_date: body.effectiveFromDate,
          note: body.note ?? null,
          created_by: principal.personId,
        });
        await this.recordSet(tx, created);
        return { row: created, history: await this.rates.history(tx, institutionId) };
      })
      .catch((error: unknown) => {
        throw isDuplicateOn(error, 'uq_institution_price_rates_effective')
          ? duplicateOn('effectiveFromDate')
          : error;
      });
    const people = await this.people.describe(peopleOfRates([row]));
    return priceRateResource(row, rateInForce(history, this.clock.todayIst())?.id, people);
  }

  /** 404 for an unknown Institution. */
  private async require(tx: Tx, institutionId: string): Promise<InstitutionRef> {
    const institution = await this.institutions.find(tx, institutionId);
    if (!institution) throw AppException.notFound();
    return institution;
  }

  /** The audit entry carries the Society and the Institution, so the Society's Owners can see it (API design 20.3). */
  private recordSet(tx: Tx, row: PriceRateRow): Promise<string> {
    return this.audit.record(tx, {
      action: 'price_rate.set',
      institutionId: row.institution_id,
      societyId: row.society_id,
      entityType: 'institution_price_rate',
      entityId: row.id,
      after: auditView(row),
    });
  }
}
