import { message, type Language } from '../../common/i18n/messages.js';
import type { ImportRunRow } from './import.repository.js';
import type { RowError } from './import.rules.js';

/** IMP-03's answer: the operation resource (API design 16.2) for an import. */
export interface ImportResource {
  id: string;
  kind: 'import';
  runStatus: number;
  institutionId: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  result: {
    /** The data rows of the file; empty until the worker has read it. */
    totalRows: number | null;
    /** How many rows the worker has settled, for a progress bar. */
    processedRows: number;
    importedRows: number;
    skippedRows: number;
    /** A section now holds more students than its capacity (PRD 7.3). */
    overCapacity: boolean;
    /** "x students imported, y row(s) skipped". */
    summary: string;
    /** Up to 1,000 skipped rows, in file order. */
    rowErrors: RowError[];
  };
  /** Why a failed run read no row. */
  error: { code: string; message: string } | null;
}

/** "409 students imported, 3 row(s) skipped" (PRD 7.6). */
export const importSummary = (imported: number, skipped: number): string =>
  `${imported} students imported, ${skipped} row(s) skipped`;

export function importResource(row: ImportRunRow, language?: Language): ImportResource {
  return {
    id: row.id,
    kind: 'import',
    runStatus: row.run_status,
    institutionId: row.institution_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: {
      totalRows: row.total_rows,
      processedRows: row.processed_rows,
      importedRows: row.imported_rows,
      skippedRows: row.skipped_rows,
      overCapacity: row.over_capacity,
      summary: importSummary(row.imported_rows, row.skipped_rows),
      rowErrors: row.row_errors as RowError[],
    },
    error:
      row.error_code === null
        ? null
        : { code: row.error_code, message: message(row.error_code, language) },
  };
}
