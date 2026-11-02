import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { DatabaseService, type Tx } from '../../platform/database/index.js';
import { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import { DueRepository, type DueRow } from './due.repository.js';
import { ownerDue, ownerDueLine, type OwnerDue, type OwnerDues } from './due.resource.js';
import { outstandingAmount } from './due.rules.js';

const NOTHING_DUE = '0.00';

/**
 * BIL-01 and BIL-02 (PRD 9.3): a Society Owner reads what BravyNix has charged
 * their Society. Read only. The database shows an Owner their own Society's
 * dues and no others, so a due of another Society is simply not found (404).
 */
@Injectable()
export class OwnerDueService {
  constructor(
    private readonly database: DatabaseService,
    private readonly dues: DueRepository,
    private readonly institutions: InstitutionDirectory,
    private readonly scope: ScopeService,
  ) {}

  /** BIL-01: the total still due, whether any money is owed, and every due newest first. */
  async list(principal: Principal): Promise<OwnerDues> {
    const { tenant } = await this.scope.forPrincipal(principal);
    return this.database.transaction(tenant, async (tx) => {
      const rows = await this.dues.all(tx);
      const names = await this.namesOf(tx, rows);
      const totalDueAmount = outstandingAmount(rows);
      return {
        // A due of 0.00 is listed but owes nothing, so the banner reads "All dues are paid" (BravyNix, 1 Nov 2026).
        banner: { totalDueAmount, hasOpenDues: totalDueAmount !== NOTHING_DUE },
        dues: rows.map((row) => ownerDueLine(row, names)),
      };
    });
  }

  /** BIL-02: 404 for an unknown due or one of another Society. */
  async get(principal: Principal, dueId: string): Promise<OwnerDue> {
    const { tenant } = await this.scope.forPrincipal(principal);
    return this.database.transaction(tenant, async (tx) => {
      const row = await this.dues.find(tx, dueId);
      if (!row) throw AppException.notFound();
      return ownerDue(row, await this.namesOf(tx, [row]));
    });
  }

  private namesOf(tx: Tx, rows: readonly DueRow[]) {
    return this.institutions.names(tx, [...new Set(rows.map((row) => row.institution_id))]);
  }
}
