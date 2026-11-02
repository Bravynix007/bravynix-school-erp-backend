import type { Tx } from '../database/index.js';

/**
 * What each Society still owes BravyNix, for the Society list and profile
 * (PLT-02, PLT-04). The dues belong to Platform billing, a business module that
 * Tenancy may not import (SDD 9.3 rule 2), so Tenancy states what it needs here
 * and Platform billing provides it.
 */
export abstract class SocietyDues {
  /** The total of the dues still Due, as a two-decimal string, by Society ID; a Society that owes nothing is left out. */
  abstract outstanding(tx: Tx, societyIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
