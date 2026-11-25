import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import type { Tx } from '../../platform/database/index.js';
import { AcademicYearRepository } from './academic-year.repository.js';

/** The first and last day of an academic year, as the date rules of Attendance and Diary need them. */
export interface YearSpan {
  startDate: string;
  endDate: string;
}

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
   * The year of this Institution: whether it is open to new work (for a caller that answers a closed year in its own
   * words) and its first and last day; `undefined` when the caller cannot see it or it belongs to another Institution.
   */
  async openYear(
    tx: Tx,
    yearId: string,
    institutionId: string,
  ): Promise<(YearSpan & { open: boolean }) | undefined> {
    const year = await this.years.find(tx, yearId);
    return year?.institution_id === institutionId
      ? { open: year.status === 1, startDate: year.start_date, endDate: year.end_date }
      : undefined;
  }

  /**
   * The active year of the Institution that has a day between `from` and `to` (the current one when several do), with
   * its first and last day; `undefined` when none does.
   */
  async overlapping(
    tx: Tx,
    institutionId: string,
    from: string,
    to: string,
  ): Promise<(YearSpan & { id: string }) | undefined> {
    const year = await this.years.overlapping(tx, institutionId, from, to);
    return year && { id: year.id, startDate: year.start_date, endDate: year.end_date };
  }

  /** The current academic year of the Institution, or `null` when none is set. */
  async currentId(tx: Tx, institutionId: string): Promise<string | null> {
    return (await this.years.currentOf(tx, institutionId))?.id ?? null;
  }

  /** The current academic year of the Institution; 422 `CURRENT_YEAR_REQUIRED` when none is set. */
  async requireCurrentId(tx: Tx, institutionId: string): Promise<string> {
    const id = await this.currentId(tx, institutionId);
    if (id === null) throw AppException.businessRule(ErrorCode.CURRENT_YEAR_REQUIRED);
    return id;
  }

  /**
   * The year a read is about: the one named, open or not (404 when it is not one of this Institution's), or the
   * Institution's current year when none is named (422 `CURRENT_YEAR_REQUIRED` when it has none).
   */
  async yearToRead(tx: Tx, institutionId: string, yearId?: string): Promise<string> {
    if (yearId === undefined) return this.requireCurrentId(tx, institutionId);
    if ((await this.openYear(tx, yearId, institutionId)) === undefined) {
      throw AppException.notFound();
    }
    return yearId;
  }
}
