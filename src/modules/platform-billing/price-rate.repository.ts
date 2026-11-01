import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { InstitutionPriceRatesTable } from './billing.tables.js';

export type PriceRateRow = Selectable<InstitutionPriceRatesTable>;
export type NewPriceRate = Insertable<InstitutionPriceRatesTable>;

/** Queries on `institution_price_rates`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class PriceRateRepository {
  insert(tx: Tx, values: NewPriceRate): Promise<PriceRateRow> {
    return tx
      .insertInto('institution_price_rates')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Every rate of the Institution, the one that starts latest first. */
  history(tx: Tx, institutionId: string): Promise<PriceRateRow[]> {
    return tx
      .selectFrom('institution_price_rates')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .orderBy('effective_from_date', 'desc')
      .execute();
  }
}
