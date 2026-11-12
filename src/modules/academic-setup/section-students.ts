import type { Tx } from '../../platform/database/index.js';

/**
 * What Academic setup asks of People about students: how many sit in each section now. The placements belong to
 * People, which already depends on Academic setup, so Academic setup states what it needs here and People provides
 * it (SDD 9.3 rules 1 and 7), as it does for `TeachingStaff`.
 *
 * A student sits in a section while their placement there is open: deactivating the student, moving them or
 * promoting them closes it. Every call runs in the caller's transaction, under row-level security.
 */
export abstract class SectionStudents {
  /** The students now in each of these sections; a section with none is `0`. */
  abstract countsOf(tx: Tx, sectionIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}
