import { Injectable } from '@nestjs/common';
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
}
