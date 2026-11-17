import type { Tx } from '../../platform/database/index.js';

/**
 * What Timetable asks of People about a child: where they sit now. The guardians and placements belong to People,
 * which provides this (SDD 9.3 rules 1 and 7). The context of a parent's request is `ChildContexts`.
 */
export abstract class TimetableChildren {
  /** The section the child sits in now, or `undefined` for a child with no open placement. */
  abstract currentSectionId(tx: Tx, studentId: string): Promise<string | undefined>;
}
