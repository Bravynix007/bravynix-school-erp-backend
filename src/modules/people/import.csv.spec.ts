import {
  CsvRejected,
  IMPORT_HEADER,
  MAX_IMPORT_ROWS,
  parseCsv,
  readStudentCsv,
  sampleCsv,
} from './import.csv.js';

const header = IMPORT_HEADER.join(',');
const file = (...lines: string[]) => Buffer.from(lines.join('\n'));
const rejection = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

/** A file of `n` data rows. */
const fileOf = (n: number) =>
  Buffer.from(
    [header, ...Array.from({ length: n }, (_v, i) => `S ${i},${i},5th,A,G,9876543210,`)].join('\n'),
  );

describe('parseCsv', () => {
  it('splits records at line breaks and cells at commas, with any line ending', () => {
    expect(parseCsv('a,b\r\nc,d\ne,f\rg,h\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('reads a quoted cell with a comma, a doubled quote and a line break in it', () => {
    expect(parseCsv('"Rao, Asha","say ""hi""","one\ntwo",plain')).toEqual([
      ['Rao, Asha', 'say "hi"', 'one\ntwo', 'plain'],
    ]);
  });

  it('keeps empty cells, and the last record without a final line break', () => {
    expect(parseCsv('a,,c\n,,')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('takes a quote inside a cell that did not start with one as an ordinary character', () => {
    expect(parseCsv('5" ruler,x')).toEqual([['5" ruler', 'x']]);
  });

  it('is unreadable when a quoted cell is never closed', () => {
    expect(rejection(() => parseCsv('a,"b\nc'))).toMatchObject({ code: 'CSV_UNREADABLE' });
  });

  it('reads an empty file as no records', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('readStudentCsv', () => {
  it('returns each data row with its number as a spreadsheet shows it, the header being row 1', () => {
    const rows = readStudentCsv(
      file(
        header,
        'Asha Rao,1,5th,A,Meera Rao,9876543210,',
        'Kabir,2,5th,A,Imran,9123456780,k@x.test',
      ),
    );
    expect(rows).toEqual([
      { row: 2, cells: ['Asha Rao', '1', '5th', 'A', 'Meera Rao', '9876543210', ''] },
      { row: 3, cells: ['Kabir', '2', '5th', 'A', 'Imran', '9123456780', 'k@x.test'] },
    ]);
  });

  it('skips blank rows and keeps the numbers of the rows after them', () => {
    const rows = readStudentCsv(
      file(header, '', 'A B,1,5th,A,G,9876543210,', ' , , , , , , ', 'C D,2,5th,A,G,9876543210,'),
    );
    expect(rows.map((r) => r.row)).toEqual([3, 5]);
  });

  it('takes a byte order mark and a header-only file', () => {
    expect(readStudentCsv(Buffer.from(`﻿${header}\r\n`))).toEqual([]);
  });

  it.each([
    ['an empty file', ''],
    ['a different order', 'RollNumber,Name,Class,Section,GuardianName,GuardianPhone,GuardianEmail'],
    ['a missing column', 'Name,RollNumber,Class,Section,GuardianName,GuardianPhone'],
    ['an extra column', `${header},Notes`],
    ['a different case', header.toLowerCase()],
    ['a space in a name', header.replace('RollNumber', 'Roll Number')],
  ])('fails the whole run for %s: CSV_HEADER_INVALID', (_name, first) => {
    expect(rejection(() => readStudentCsv(Buffer.from(first)))).toMatchObject({
      code: 'CSV_HEADER_INVALID',
    });
  });

  it('fails the whole run for bytes that are not UTF-8: CSV_UNREADABLE', () => {
    const bytes = Buffer.concat([
      Buffer.from(`${header}\nA,1,5th,A,G,9876543210,\n`),
      Buffer.from([0xff, 0xfe]),
    ]);
    expect(rejection(() => readStudentCsv(bytes))).toBeInstanceOf(CsvRejected);
    expect(rejection(() => readStudentCsv(bytes))).toMatchObject({ code: 'CSV_UNREADABLE' });
  });

  it('takes 5,000 data rows and fails the whole run for one more: CSV_TOO_LARGE', () => {
    expect(readStudentCsv(fileOf(MAX_IMPORT_ROWS))).toHaveLength(MAX_IMPORT_ROWS);
    expect(rejection(() => readStudentCsv(fileOf(MAX_IMPORT_ROWS + 1)))).toMatchObject({
      code: 'CSV_TOO_LARGE',
    });
  });

  it('counts blank rows out of the 5,000', () => {
    const blanks = '\n'.repeat(100);
    const rows = Array.from(
      { length: MAX_IMPORT_ROWS },
      (_v, i) => `S ${i},${i},5th,A,G,9876543210,`,
    );
    expect(readStudentCsv(Buffer.from(`${header}\n${blanks}${rows.join('\n')}`))).toHaveLength(
      MAX_IMPORT_ROWS,
    );
  });
});

describe('sampleCsv', () => {
  it('is a file the importer accepts, with the header first', () => {
    const rows = readStudentCsv(Buffer.from(sampleCsv()));
    expect(sampleCsv().startsWith(`${header}\r\n`)).toBe(true);
    expect(rows).toHaveLength(2);
  });
});
