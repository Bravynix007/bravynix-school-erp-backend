import { authorOf, type AuthorRef } from '../../common/http/author-stamps.js';
import { rateInForce } from './price-rate.rules.js';
import type { PriceRateRow } from './price-rate.repository.js';

/** One rate of an Institution (PLT-22, PLT-23). */
export interface PriceRateResource {
  id: string;
  institutionId: string;
  ratePerStudentAmount: string;
  effectiveFromDate: string;
  note: string | null;
  /** The rate that applies today; at most one row is. */
  inForce: boolean;
  createdAt: string;
  createdBy: AuthorRef;
}

export function priceRateResource(
  row: PriceRateRow,
  inForceId: string | undefined,
  people: ReadonlyMap<string, AuthorRef>,
): PriceRateResource {
  return {
    id: row.id,
    institutionId: row.institution_id,
    ratePerStudentAmount: row.rate_per_student_amount,
    effectiveFromDate: row.effective_from_date,
    note: row.note,
    inForce: row.id === inForceId,
    createdAt: row.created_at.toISOString(),
    createdBy: authorOf(row.created_by, people),
  };
}

/** The history with `inForce` set on the row that applies on `today`. */
export function priceRateResources(
  rows: readonly PriceRateRow[],
  today: string,
  people: ReadonlyMap<string, AuthorRef>,
): PriceRateResource[] {
  const inForceId = rateInForce(rows, today)?.id;
  return rows.map((row) => priceRateResource(row, inForceId, people));
}

/** Everyone a set of rates names, for one lookup. */
export function peopleOfRates(rows: readonly PriceRateRow[]): string[] {
  return [...new Set(rows.map((row) => row.created_by))];
}
