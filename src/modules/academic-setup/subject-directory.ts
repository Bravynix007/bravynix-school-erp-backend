import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import type { Tx } from '../../platform/database/index.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { SubjectRepository, type SubjectRow } from './subject.repository.js';
import { subjectResource, type SubjectResource } from './subject.resource.js';

/**
 * What the Academic setup module tells other modules about the Society's subjects. The `subjects` table stays
 * private to it (SDD 9.3 rule 1). It reads under the caller's row-level security, so a subject of another Society is
 * not found.
 */
@Injectable()
export class SubjectDirectory {
  constructor(
    private readonly subjects: SubjectRepository,
    private readonly people: PersonDirectory,
  ) {}

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

  /** The Society's active subjects by name; with `ids`, only those of them. Shown by [resources]. */
  active(tx: Tx, societyId: string, ids?: readonly string[]): Promise<SubjectRow[]> {
    return this.subjects.active(tx, societyId, ids);
  }

  /** Subjects read by [active], as SUB-01 shows them (API design 10.4i). Outside the transaction. */
  async resources(rows: readonly SubjectRow[]): Promise<SubjectResource[]> {
    const people = await this.people.describe(authorIdsOf(rows));
    return rows.map((row) => subjectResource(row, people));
  }
}
