import type { ImportRunRow } from './import.repository.js';
import { importResource, importSummary } from './import.resource.js';

const at = new Date('2026-11-15T05:00:00.000Z');
const run = (changes: Partial<ImportRunRow> = {}): ImportRunRow => ({
  id: 'run-1',
  created_at: at,
  created_by: 'person-1',
  society_id: 'society-1',
  institution_id: 'institution-1',
  import_type: 1,
  file_id: 'file-1',
  academic_year_id: 'year-1',
  run_status: 1,
  total_rows: null,
  imported_rows: 0,
  skipped_rows: 0,
  processed_rows: 0,
  row_errors: [],
  over_capacity: false,
  error_code: null,
  started_at: null,
  finished_at: null,
  ...changes,
});

describe('importResource', () => {
  it('shows a queued run with nothing counted yet', () => {
    expect(importResource(run())).toEqual({
      id: 'run-1',
      kind: 'import',
      runStatus: 1,
      institutionId: 'institution-1',
      createdAt: at,
      startedAt: null,
      finishedAt: null,
      result: {
        totalRows: null,
        processedRows: 0,
        importedRows: 0,
        skippedRows: 0,
        overCapacity: false,
        summary: '0 students imported, 0 row(s) skipped',
        rowErrors: [],
      },
      error: null,
    });
  });

  it('shows a finished run with its skipped rows in the words of the result', () => {
    const resource = importResource(
      run({
        run_status: 3,
        total_rows: 412,
        processed_rows: 412,
        imported_rows: 409,
        skipped_rows: 3,
        row_errors: [{ row: 4, message: "'9th' is not a recognized class" }],
        started_at: at,
        finished_at: at,
      }),
    );
    expect(resource.result).toMatchObject({
      totalRows: 412,
      summary: '409 students imported, 3 row(s) skipped',
      rowErrors: [{ row: 4, message: "'9th' is not a recognized class" }],
    });
    expect(resource.error).toBeNull();
  });

  it('shows why a failed run read no row, in the language of the caller', () => {
    const failed = run({ run_status: 4, error_code: 'CSV_HEADER_INVALID', finished_at: at });
    expect(importResource(failed).error).toEqual({
      code: 'CSV_HEADER_INVALID',
      message: expect.stringContaining('Name,RollNumber,Class,Section') as string,
    });
  });
});

describe('importSummary', () => {
  it('uses the words of PRD 7.6', () => {
    expect(importSummary(1, 1)).toBe('1 students imported, 1 row(s) skipped');
  });
});
