import { body, problems } from '../../../test/support/dto-validation.js';
import { ListImportsQueryDto, StartImportDto } from './import.dto.js';

const id = (n: number) => `0192f3b0-0000-7000-8000-00000000000${n}`;
const start = { institutionId: id(1), importType: 1, fileId: id(2), academicYearId: id(3) };

describe('StartImportDto', () => {
  it('takes an Institution, a student import, a file and a year', async () => {
    expect(await problems(body(StartImportDto, start))).toEqual([]);
  });

  it.each([
    ['no Institution', { ...start, institutionId: undefined }, 'institutionId'],
    ['no file', { ...start, fileId: undefined }, 'fileId'],
    ['no year', { ...start, academicYearId: undefined }, 'academicYearId'],
    ['a file that is not an ID', { ...start, fileId: 'x' }, 'fileId'],
    ['another kind of import', { ...start, importType: 2 }, 'importType'],
    ['an import type sent as text', { ...start, importType: '1' }, 'importType'],
  ])('refuses %s', async (_name, fields, field) => {
    const found = await problems(body(StartImportDto, fields));
    expect(found.map((p) => p.field)).toContain(field);
  });
});

describe('ListImportsQueryDto', () => {
  it('needs the Institution and takes a page', async () => {
    expect(
      await problems(body(ListImportsQueryDto, { institutionId: id(1), page: '2', limit: '10' })),
    ).toEqual([]);
    const found = await problems(body(ListImportsQueryDto, {}));
    expect(found.map((p) => p.field)).toEqual(['institutionId']);
  });
});
