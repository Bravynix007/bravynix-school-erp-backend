import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import type { Tx } from '../../platform/database/index.js';
import { AcademicYearRepository } from './academic-year.repository.js';

/**
 * What the Academic setup module tells other modules about an Institution's academic years. The `academic_years`
 * table stays private to it (SDD 9.3 rule 1). It reads under the caller's row-level security.
 */
@Injectable()
export class AcademicYearDirectory {
  constructor(private readonly years: AcademicYearRepository) {}

  /**
   * The year must be one of this Institution (404 when it is not, or is another's) and active (422
   * `REFERENCE_INACTIVE` on `field`).
   */
  async requireActive(tx: Tx, yearId: string, institutionId: string, field: string): Promise<void> {
    const year = await this.years.find(tx, yearId);
    if (year?.institution_id !== institutionId) throw AppException.notFound();
    if (year.status === 0) throw AppException.referenceInactive(field);
  }

  /**
   * Whether the year of this Institution is open to new work, or `undefined` when the caller cannot see it or it
   * belongs to another Institution. For a caller that answers a closed year in its own words.
   */
  async openIn(tx: Tx, yearId: string, institutionId: string): Promise<boolean | undefined> {
    const year = await this.years.find(tx, yearId);
    return year?.institution_id === institutionId ? year.status === 1 : undefined;
  }

  /** The current academic year of the Institution, or `null` when none is set. */
  async currentId(tx: Tx, institutionId: string): Promise<string | null> {
    return (await this.years.currentOf(tx, institutionId))?.id ?? null;
  }
}
