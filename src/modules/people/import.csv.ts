/**
 * The student CSV file (API design 10.8): UTF-8, comma separated, one header row, at most 5,000 data rows. A file
 * that cannot be read at all fails the whole run, and no row is imported.
 */
export const IMPORT_HEADER = [
  'Name',
  'RollNumber',
  'Class',
  'Section',
  'GuardianName',
  'GuardianPhone',
  'GuardianEmail',
] as const;

export const MAX_IMPORT_ROWS = 5_000;

/** Why a file fails the whole run. The codes are the ones API design 10.8 and 16.3 name. */
export const CsvFailure = {
  HeaderInvalid: 'CSV_HEADER_INVALID',
  TooLarge: 'CSV_TOO_LARGE',
  Unreadable: 'CSV_UNREADABLE',
} as const;
export type CsvFailure = (typeof CsvFailure)[keyof typeof CsvFailure];

/** The file cannot be imported as a whole; `code` says why. */
export class CsvRejected extends Error {
  constructor(readonly code: CsvFailure) {
    super(code);
    this.name = 'CsvRejected';
  }
}

/** One data row: its number as a spreadsheet shows it (the header is row 1) and its cells, as written. */
export interface CsvRow {
  row: number;
  cells: string[];
}

/**
 * Splits the text into records by RFC 4180: a cell may be quoted to hold a comma, a quote (doubled) or a line break,
 * and a record ends at a line break outside quotes. A record that is empty is dropped; the rows after it keep their
 * numbers. A quote inside a cell that did not start with one is an ordinary character. `Unreadable` when a quoted
 * cell is never closed.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  let index = 0;

  const endCell = (): void => {
    cells.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRecord = (): void => {
    endCell();
    records.push(cells);
    cells = [];
  };

  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (char === ',') {
      endCell();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      endRecord();
    } else {
      cell += char;
    }
    index += 1;
  }
  if (quoted) throw new CsvRejected(CsvFailure.Unreadable);
  if (cell !== '' || wasQuoted || cells.length > 0) endRecord();
  return records;
}

/** A record with nothing in it: a blank line, or a line of commas and spaces. */
const isBlank = (cells: readonly string[]): boolean => cells.every((cell) => cell.trim() === '');

/**
 * The data rows of a student CSV. The file is UTF-8 (a byte order mark is allowed) and starts with exactly the
 * header `IMPORT_HEADER`; blank records are skipped. `CsvRejected` otherwise, and `TooLarge` past 5,000 data rows.
 */
export function readStudentCsv(file: Buffer): CsvRow[] {
  let text: string;
  try {
    // The decoder drops a byte order mark (Excel saves "CSV UTF-8" with one) unless told to keep it.
    text = new TextDecoder('utf-8', { fatal: true }).decode(file);
  } catch {
    throw new CsvRejected(CsvFailure.Unreadable);
  }
  const [header, ...records] = parseCsv(text);
  if (
    header === undefined ||
    header.length !== IMPORT_HEADER.length ||
    header.some((name, position) => name !== IMPORT_HEADER[position])
  ) {
    throw new CsvRejected(CsvFailure.HeaderInvalid);
  }
  const rows = records.flatMap((cells, position) =>
    isBlank(cells) ? [] : [{ row: position + 2, cells }],
  );
  if (rows.length > MAX_IMPORT_ROWS) throw new CsvRejected(CsvFailure.TooLarge);
  return rows;
}

/** The sample file IMP-01 sends: the header and two rows to show how a row reads. */
export function sampleCsv(): string {
  const rows = [
    IMPORT_HEADER.join(','),
    'Asha Rao,1,5th,A,Meera Rao,9876543210,meera.rao@example.com',
    'Kabir Shah,2,5th,A,Imran Shah,9123456780,',
  ];
  return `${rows.join('\r\n')}\r\n`;
}
