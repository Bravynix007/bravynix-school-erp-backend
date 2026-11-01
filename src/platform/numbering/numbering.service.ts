import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../database/index.js';
import {
  PLATFORM_INVOICE_WIDTH,
  SequenceType,
  financialYearOf,
  formatNumber,
  platformInvoicePrefix,
} from './numbering.rules.js';

/**
 * Gap-free numbers (SDD 10.4). A number is taken inside the transaction that
 * uses it: the counter row is locked until that transaction ends, so two
 * callers never get the same number, and a rollback hands the number back.
 */
@Injectable()
export class NumberSequenceService {
  /**
   * The next platform invoice number for the financial year of `day`, for
   * example `BNX/FY2026-27/0007`. The counter starts at 1 each April.
   */
  async nextPlatformInvoice(tx: Tx, day: string): Promise<string> {
    const year = financialYearOf(day);
    const prefix = platformInvoicePrefix(year);
    const issued = await this.take(tx, SequenceType.PlatformInvoice, year.key, prefix);
    return formatNumber(prefix, issued, PLATFORM_INVOICE_WIDTH);
  }

  /**
   * One insert that either starts the counter at 1 or moves it on; both lock
   * the row, and the `returning` clause reads the number this call took.
   */
  private async take(
    tx: Tx,
    type: SequenceType,
    periodKey: string,
    prefix: string,
  ): Promise<number> {
    const { rows } = await sql<{ issued: number }>`
      insert into number_sequences (sequence_type, period_key, prefix, next_value)
      values (${type}, ${periodKey}, ${prefix}, 2)
      on conflict on constraint uq_number_sequences_scope
      do update set next_value = number_sequences.next_value + 1
      returning next_value - 1 as issued
    `.execute(tx);
    return Number(rows[0]!.issued);
  }
}
