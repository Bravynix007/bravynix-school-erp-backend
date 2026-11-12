import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { ClassRepository } from './class.repository.js';

/**
 * What the Academic setup module tells other modules about classes. The `classes` table stays private to it
 * (SDD 9.3 rule 1). It reads under the caller's row-level security, so a class of an Institution the caller does not
 * reach is not found.
 */
@Injectable()
export class ClassDirectory {
  constructor(private readonly classes: ClassRepository) {}

  /**
   * Whether this class is the last one the Institution runs, so a student leaving it has completed school there
   * (DDD 9.6, outcome 4); `undefined` when the caller cannot see the class or it belongs to another Institution.
   */
  async isLast(tx: Tx, classId: string, institutionId: string): Promise<boolean | undefined> {
    const found = await this.classes.isLast(tx, classId);
    return found?.institutionId === institutionId ? found.isLast : undefined;
  }
}
