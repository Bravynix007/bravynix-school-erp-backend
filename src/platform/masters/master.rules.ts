import { AppException } from '../../common/http/app-exception.js';
import { FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import type { MasterSpec } from './master.catalog.js';

/** The entries that move by one place to make room: positions `from` to `to`, down (`1`) or up (`-1`) the list. */
export interface Shift {
  range: { from: number; to: number };
  by: 1 | -1;
}

function outOfRange(max: number): AppException {
  return AppException.validation([
    {
      ...fieldError('displayOrder', FieldErrorCode.OUT_OF_RANGE),
      params: { min: 1, max },
    },
  ]);
}

/**
 * Where a new entry goes in a list of `count` entries: the position asked for, or the end. The entries
 * from that position on move down one. A position past the end is `OUT_OF_RANGE`.
 */
export function planInsert(
  position: number | undefined,
  count: number,
): { position: number; shift: Shift | null } {
  const last = count + 1;
  const at = position ?? last;
  if (at < 1 || at > last) throw outOfRange(last);
  return { position: at, shift: at === last ? null : { range: { from: at, to: count }, by: 1 } };
}

/**
 * Moving the entry at `current` to `target` in a list of `count` entries: the ones in between move one
 * place the other way. `null` when it is already there.
 */
export function planMove(current: number, target: number, count: number): Shift | null {
  if (target < 1 || target > count) throw outOfRange(count);
  if (target === current) return null;
  return target < current
    ? { range: { from: target, to: current - 1 }, by: 1 }
    : { range: { from: current + 1, to: target }, by: -1 };
}

/**
 * The query filters of a list against what the master takes. A filter the master does not have is
 * `FIELD_NOT_ALLOWED`, a required one that is missing is `REQUIRED` (API design 10.4g).
 */
export function listFilters(
  spec: MasterSpec,
  query: Readonly<Record<string, unknown>>,
): { column: string; value: string }[] {
  const known = new Set(spec.filters.map(({ api }) => api));
  const errors = ['countryId', 'stateId', 'classCategoryId']
    .filter((name) => query[name] !== undefined && !known.has(name))
    .map((name) => fieldError(name, FieldErrorCode.FIELD_NOT_ALLOWED));
  for (const filter of spec.filters) {
    if (filter.required && query[filter.api] === undefined) {
      errors.push(fieldError(filter.api, FieldErrorCode.REQUIRED));
    }
  }
  if (errors.length) throw AppException.validation(errors);
  return spec.filters
    .filter(({ api }) => query[api] !== undefined)
    .map(({ api, column }) => ({ column, value: query[api] as string }));
}
