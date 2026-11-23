import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { DatabaseService, type Tx } from '../../platform/database/index.js';
import { ScopeService, type InstitutionContext } from '../../platform/tenancy/index.js';
import { SectionRepository } from './section.repository.js';

/** A section as another module names it: its own name, and the class it is in. */
export interface SectionName {
  displayName: string;
  classId: string;
  className: string;
}

/** An open section and the open class it is in, named as a person types them (the CSV import reads them). */
export interface OpenSection {
  sectionId: string;
  classId: string;
  className: string;
  sectionName: string;
}

/** Where a student can be placed: the section's class and Institution, whether it is open, and its capacity. */
export interface SectionPlace {
  classId: string;
  institutionId: string;
  active: boolean;
  /** Empty when the section has no limit. */
  capacity: number | null;
}

/**
 * What the Academic setup module tells other modules about sections. The `sections` and `classes` tables stay
 * private to it (SDD 9.3 rule 1). It reads under the caller's row-level security, so a section of an Institution
 * the caller does not reach is not found.
 */
@Injectable()
export class SectionDirectory {
  constructor(
    private readonly sections: SectionRepository,
    private readonly database: DatabaseService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * The Institution of a section named by its ID alone, which the caller must reach: 404 for a section that does not
   * exist or is of an Institution outside their reach. A deactivated section is answered; the caller decides.
   */
  async contextOf(principal: Principal, sectionId: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const place = await this.database.transaction(tenant, (tx) => this.placeOf(tx, sectionId));
    if (!place) throw AppException.notFound();
    return this.scope.requireInstitution(principal, place.institutionId);
  }

  /** 404 when the section does not exist for the caller, 422 `REFERENCE_INACTIVE` on `field` when deactivated. */
  async requireActive(tx: Tx, id: string, field: string): Promise<void> {
    const section = await this.sections.find(tx, id);
    if (!section) throw AppException.notFound();
    if (section.status === 0) throw AppException.referenceInactive(field);
  }

  /**
   * The section as a placement sees it, or `undefined` when the caller cannot see it. The section is held open until
   * the transaction ends, so it cannot be deactivated between this check and the placement (SEC-04, CLS-05).
   */
  async placeOf(tx: Tx, id: string): Promise<SectionPlace | undefined> {
    const section = await this.sections.keptOpen(tx, id);
    return (
      section && {
        classId: section.class_id,
        institutionId: section.institution_id,
        active: section.status === 1,
        capacity: section.capacity,
      }
    );
  }

  /** Every open section of the Institution, with its open class's name, in the order of the class and section lists. */
  async openOf(tx: Tx, institutionId: string): Promise<OpenSection[]> {
    const rows = await this.sections.openOf(tx, institutionId);
    return rows.map((row) => ({
      sectionId: row.id,
      classId: row.classId,
      className: row.className,
      sectionName: row.displayName,
    }));
  }

  /** The names of these sections and of their classes, by section ID. */
  async names(tx: Tx, ids: readonly string[]): Promise<Map<string, SectionName>> {
    return this.sections.namesOf(tx, ids);
  }
}
