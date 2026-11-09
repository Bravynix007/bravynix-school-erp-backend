import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import type { Tx } from '../../platform/database/index.js';
import { SubjectRepository } from './subject.repository.js';

/**
 * What the Academic setup module tells other modules about the Society's subjects. The `subjects` table stays
 * private to it (SDD 9.3 rule 1). It reads under the caller's row-level security, so a subject of another Society is
 * not found.
 */
@Injectable()
export class SubjectDirectory {
  constructor(private readonly subjects: SubjectRepository) {}

  /**
   * Each subject must exist in the caller's Society (404) and be active (422 `REFERENCE_INACTIVE` on `field`), the
   * first problem found in the order given.
   */
  async requireActive(tx: Tx, ids: readonly string[], field: string): Promise<void> {
    const statuses = await this.subjects.statusesOf(tx, ids);
    for (const id of ids) {
      const status = statuses.get(id);
      if (status === undefined) throw AppException.notFound();
      if (status === 0) throw AppException.referenceInactive(field);
    }
  }

  /** The name of each of these subjects, by ID. */
  names(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
    return this.subjects.namesOf(tx, ids);
  }
}
