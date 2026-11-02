import { Injectable } from '@nestjs/common';
import { SocietyDues } from '../../platform/tenancy/index.js';
import type { Tx } from '../../platform/database/index.js';
import { DueRepository } from './due.repository.js';

/** The dues figures other parts of the platform show (PLT-01, PLT-02, PLT-04). Read only. */
@Injectable()
export class DueFigures extends SocietyDues {
  constructor(private readonly dues: DueRepository) {
    super();
  }

  outstanding(tx: Tx, societyIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return this.dues.outstandingBySociety(tx, societyIds);
  }

  /** The total of every due still Due. */
  outstandingTotal(tx: Tx): Promise<string> {
    return this.dues.outstandingTotal(tx);
  }

  /** The total of the dues paid from `from` up to but not including `before` (calendar dates). */
  collectedBetween(tx: Tx, from: string, before: string): Promise<string> {
    return this.dues.collectedBetween(tx, from, before);
  }
}
