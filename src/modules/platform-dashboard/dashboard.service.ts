import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { Clock } from '../../common/time/clock.js';
import { DatabaseService, platformTenant } from '../../platform/database/index.js';
import { InstitutionDirectory } from '../../platform/tenancy/index.js';
import { DueFigures } from '../platform-billing/index.js';
import type { PlatformDashboard } from './dashboard.resource.js';
import { monthsAround } from './dashboard.rules.js';

/**
 * PLT-01 (PRD 9.6): a read-only composition of what Tenancy and Platform billing
 * count; the dashboard owns no data. The figures are worked out when asked: a
 * payment recorded a moment ago is already in them.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly database: DatabaseService,
    private readonly institutions: InstitutionDirectory,
    private readonly dues: DueFigures,
    private readonly clock: Clock,
  ) {}

  async get(principal: Principal): Promise<PlatformDashboard> {
    const { thisMonth, lastMonth } = monthsAround(this.clock.todayIst());
    return this.database.transaction(platformTenant(principal), async (tx) => {
      const counts = await this.institutions.activeCounts(tx);
      return {
        societies: counts.societies,
        institutions: counts.institutions,
        activeStudents: null,
        duesOutstandingAmount: await this.dues.outstandingTotal(tx),
        duesCollectedThisMonthAmount: await this.dues.collectedBetween(
          tx,
          thisMonth.from,
          thisMonth.before,
        ),
        duesCollectedLastMonthAmount: await this.dues.collectedBetween(
          tx,
          lastMonth.from,
          lastMonth.before,
        ),
        openAiReports: null,
      };
    });
  }
}
