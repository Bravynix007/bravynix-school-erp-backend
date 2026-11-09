import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import type { Tx } from '../database/index.js';
import { InstitutionRepository } from './institution.repository.js';
import { SocietyRepository } from './society.repository.js';

/** An Institution as another module needs to know it. */
export interface InstitutionRef {
  id: string;
  societyId: string;
  name: string;
  /** The Institution and its Society are both active: only then may a module add to them. */
  active: boolean;
}

/** An Institution and its Society, by name, for a list that shows both. */
export interface InstitutionName {
  id: string;
  name: string;
  societyId: string;
  societyName: string;
}

/**
 * Which Institution an ID names, for other modules. The `institutions` and
 * `societies` tables stay private to Tenancy (SDD 9.3 rule 1). It reads under
 * the caller's row-level security, so an Institution the caller cannot see is
 * `undefined`.
 */
@Injectable()
export class InstitutionDirectory {
  constructor(
    private readonly institutions: InstitutionRepository,
    private readonly societies: SocietyRepository,
  ) {}

  async find(tx: Tx, id: string): Promise<InstitutionRef | undefined> {
    const institution = await this.institutions.find(tx, id);
    if (!institution) return undefined;
    const society = await this.societies.find(tx, institution.society_id);
    return {
      id: institution.id,
      societyId: institution.society_id,
      name: institution.name,
      active: institution.status === 1 && society?.status === 1,
    };
  }

  /**
   * Each Institution must exist for the caller (404) and, with its Society, be active (422 `REFERENCE_INACTIVE` on
   * the item's `field`): the first problem found, in the order given. One read for all of them.
   */
  async requireActive(tx: Tx, items: readonly { id: string; field: string }[]): Promise<void> {
    const institutions = await this.institutions.refs(
      tx,
      items.map((item) => item.id),
    );
    const societies = await this.societies.refs(tx, [
      ...new Set([...institutions.values()].map((row) => row.society_id)),
    ]);
    for (const { id, field } of items) {
      const found = institutions.get(id);
      if (!found) throw AppException.notFound();
      if (found.status !== 1 || societies.get(found.society_id)?.status !== 1) {
        throw AppException.referenceInactive(field);
      }
    }
  }

  /** How many Societies, and how many Institutions in them, are active: the dashboard's figures. */
  async activeCounts(tx: Tx): Promise<{ societies: number; institutions: number }> {
    return {
      societies: await this.societies.countActive(tx),
      institutions: await this.institutions.countActive(tx),
    };
  }

  /** The names of these Institutions and their Societies, by Institution ID; an ID the caller cannot see is left out. */
  async names(tx: Tx, ids: readonly string[]): Promise<Map<string, InstitutionName>> {
    const institutions = await this.institutions.refs(tx, ids);
    const societies = await this.societies.refs(tx, [
      ...new Set([...institutions.values()].map((row) => row.society_id)),
    ]);
    return new Map(
      [...institutions.values()].map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          societyId: row.society_id,
          societyName: societies.get(row.society_id)?.name ?? '',
        },
      ]),
    );
  }
}
