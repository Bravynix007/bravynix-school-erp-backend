import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { GradeBandRow } from './grade-band.repository.js';
import { decimalOf } from './grade-band.rules.js';

/** One grade band as the API shows it (API design 9.4, GRD-01 to GRD-04). */
export interface GradeBandResource extends AuthorStamps {
  id: string;
  institutionId: string;
  name: string;
  /** Both ends belong to the band; two decimals at most. */
  minPercentage: number;
  maxPercentage: number;
  gradePoint: number | null;
  description: string | null;
  status: number;
  version: number;
}

export function gradeBandResource(
  row: GradeBandRow,
  people: ReadonlyMap<string, AuthorRef>,
): GradeBandResource {
  return {
    id: row.id,
    institutionId: row.institution_id,
    name: row.name,
    minPercentage: decimalOf(row.min_percentage),
    maxPercentage: decimalOf(row.max_percentage),
    gradePoint: decimalOf(row.grade_point),
    description: row.description,
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
