import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import type { Tx } from '../../platform/database/index.js';
import { SectionRepository } from './section.repository.js';

/** A section as another module names it: its own name, and the class it is in. */
export interface SectionName {
  displayName: string;
  classId: string;
  className: string;
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
  constructor(private readonly sections: SectionRepository) {}

  /** 404 when the section does not exist for the caller, 422 `REFERENCE_INACTIVE` on `field` when deactivated. */
  async requireActive(tx: Tx, id: string, field: string): Promise<void> {
    const section = await this.sections.find(tx, id);
    if (!section) throw AppException.notFound();
    if (section.status === 0) throw AppException.referenceInactive(field);
  }

  /** The section as a placement sees it, or `undefined` when the caller cannot see it. */
  async placeOf(tx: Tx, id: string): Promise<SectionPlace | undefined> {
    const section = await this.sections.find(tx, id);
    return (
      section && {
        classId: section.class_id,
        institutionId: section.institution_id,
        active: section.status === 1,
        capacity: section.capacity,
      }
    );
  }

  /** The names of these sections and of their classes, by section ID. */
  async names(tx: Tx, ids: readonly string[]): Promise<Map<string, SectionName>> {
    return this.sections.namesOf(tx, ids);
  }
}
