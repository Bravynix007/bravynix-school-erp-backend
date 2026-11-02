import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import type { Tx } from '../database/index.js';
import type { MasterTable } from './master.catalog.js';
import { MasterRepository } from './master.repository.js';

/** The place an Institution (or any record with an address) names: each part optional, but a chain. */
export interface PlaceIds {
  countryId?: string | null;
  stateId?: string | null;
  cityId?: string | null;
}

/** 422 `REFERENCE_INACTIVE`, naming the field that points at a hidden master entry (API design 12.2). */
function inactive(field: string): AppException {
  return new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.REFERENCE_INACTIVE, {
    errors: [fieldError(field, ErrorCode.REFERENCE_INACTIVE)],
  });
}

/** A class category as another module shows it. */
export interface ClassCategoryRef {
  id: string;
  code: string;
  name: string;
}

/** A predefined class as a class is made from it: its category travels with it. */
export interface PredefinedClassRef {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  categoryCode: string;
}

/** A predefined section as a section is made from it. */
export interface PredefinedSectionRef {
  id: string;
  code: string;
  name: string;
}

/**
 * What other modules need to know of the platform masters when a record points at one (API design 12.2):
 * the entry exists (404), it is shown (422 `REFERENCE_INACTIVE`, naming the field), and a place is a chain
 * whose parts belong together. A record that already points at a hidden entry keeps it; only a new link is checked.
 */
@Injectable()
export class MasterReferences {
  constructor(private readonly masters: MasterRepository) {}

  /** A new record points at an entry that exists and is shown. */
  async requireShown(tx: Tx, table: MasterTable, id: string, field: string): Promise<void> {
    await this.requireAllShown(tx, table, [{ id, field }]);
  }

  /** The same for several entries of one master, in one query; the first problem found, in the order given. */
  async requireAllShown(
    tx: Tx,
    table: MasterTable,
    entries: readonly { id: string; field: string }[],
  ): Promise<void> {
    const statuses = await this.masters.statusesOf(
      tx,
      table,
      entries.map((entry) => entry.id),
    );
    for (const { id, field } of entries) {
      const status = statuses.get(id);
      if (status === undefined) throw AppException.notFound();
      if (status === 0) throw inactive(field);
    }
  }

  /** A new class points at a predefined class that exists (404) and is shown (422 `REFERENCE_INACTIVE`). */
  async requirePredefinedClass(tx: Tx, id: string, field: string): Promise<PredefinedClassRef> {
    const found = await this.masters.predefinedClass(tx, id);
    if (!found) throw AppException.notFound();
    if (found.status === 0) throw inactive(field);
    const { status: _status, ...ref } = found;
    return ref;
  }

  /** A new section points at a predefined section that exists (404) and is shown (422 `REFERENCE_INACTIVE`). */
  async requirePredefinedSection(tx: Tx, id: string, field: string): Promise<PredefinedSectionRef> {
    const found = await this.masters.predefinedSection(tx, id);
    if (!found) throw AppException.notFound();
    if (found.status === 0) throw inactive(field);
    const { status: _status, ...ref } = found;
    return ref;
  }

  /** The class categories with these IDs (hidden ones too: a link that exists stays), in the order of the list. */
  classCategories(tx: Tx, ids: readonly string[]): Promise<ClassCategoryRef[]> {
    return this.masters.classCategories(tx, ids);
  }

  /**
   * A place: a state needs its country and a city its state (400 `REQUIRED`), each must exist and be shown, and
   * the state must be in the country and the city in the state (400 `INVALID_VALUE` on the part that does not
   * fit). `prefix` names the object the fields are in, for the field errors (`address`). A part that `current`
   * already holds stays even if its entry has been hidden since: only a part that is new is checked for that.
   */
  async requirePlace(
    tx: Tx,
    place: PlaceIds,
    prefix: string,
    current: PlaceIds = {},
  ): Promise<void> {
    const { countryId, stateId, cityId } = place;
    const at = (name: string) => `${prefix}.${name}`;
    if (stateId && !countryId) {
      throw AppException.validation([fieldError(at('countryId'), FieldErrorCode.REQUIRED)]);
    }
    if (cityId && !stateId) {
      throw AppException.validation([fieldError(at('stateId'), FieldErrorCode.REQUIRED)]);
    }
    if (countryId && countryId !== current.countryId) {
      await this.requireShown(tx, 'countries', countryId, at('countryId'));
    }
    if (stateId && stateId !== current.stateId) {
      await this.requireShown(tx, 'states', stateId, at('stateId'));
    }
    if (cityId && cityId !== current.cityId) {
      await this.requireShown(tx, 'cities', cityId, at('cityId'));
    }
    if (stateId && (await this.masters.parentOf(tx, 'states', stateId)) !== countryId) {
      throw AppException.validation([fieldError(at('stateId'), FieldErrorCode.INVALID_VALUE)]);
    }
    if (cityId && (await this.masters.parentOf(tx, 'cities', cityId)) !== stateId) {
      throw AppException.validation([fieldError(at('cityId'), FieldErrorCode.INVALID_VALUE)]);
    }
  }
}
