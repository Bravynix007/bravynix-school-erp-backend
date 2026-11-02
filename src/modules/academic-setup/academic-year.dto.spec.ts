import { body, problems } from '../../../test/support/dto-validation.js';
import {
  CreateAcademicYearDto,
  ListAcademicYearsQueryDto,
  UpdateAcademicYearDto,
} from './academic-year.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const valid = {
  institutionId: uuid,
  name: '2026-2027',
  startDate: '2026-06-01',
  endDate: '2027-03-31',
};

describe('CreateAcademicYearDto', () => {
  it('takes the four fields', async () => {
    expect(await problems(body(CreateAcademicYearDto, valid))).toEqual([]);
  });

  it.each([
    [{ ...valid, institutionId: undefined }, 'institutionId', 'INVALID_FORMAT'],
    [{ ...valid, institutionId: 'nope' }, 'institutionId', 'INVALID_FORMAT'],
    [{ ...valid, name: '' }, 'name', 'TOO_SHORT'],
    [{ ...valid, name: 'x'.repeat(21) }, 'name', 'TOO_LONG'],
    [{ ...valid, name: 2026 }, 'name', 'INVALID_TYPE'],
    [{ ...valid, startDate: '2026-02-30' }, 'startDate', 'INVALID_FORMAT'],
    [{ ...valid, startDate: '1/6/2026' }, 'startDate', 'INVALID_FORMAT'],
    [{ ...valid, endDate: undefined }, 'endDate', 'INVALID_TYPE'],
    [{ ...valid, isCurrent: true }, 'isCurrent', 'FIELD_NOT_ALLOWED'],
    [{ ...valid, societyId: uuid }, 'societyId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateAcademicYearDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateAcademicYearDto', () => {
  it('needs the version as a whole number, and any of the three fields', async () => {
    expect(await problems(body(UpdateAcademicYearDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(body(UpdateAcademicYearDto, { version: 2, name: 'x', endDate: '2027-04-01' })),
    ).toEqual([]);
    expect(await problems(body(UpdateAcademicYearDto, { name: 'x' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
    expect(await problems(body(UpdateAcademicYearDto, { version: '1' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });

  it('refuses null for a field, and the fields that are not editable', async () => {
    expect(await problems(body(UpdateAcademicYearDto, { version: 1, name: null }))).toContainEqual({
      field: 'name',
      code: 'INVALID_TYPE',
    });
    expect(
      await problems(body(UpdateAcademicYearDto, { version: 1, isCurrent: true })),
    ).toContainEqual({ field: 'isCurrent', code: 'FIELD_NOT_ALLOWED' });
    expect(
      await problems(body(UpdateAcademicYearDto, { version: 1, institutionId: uuid })),
    ).toContainEqual({ field: 'institutionId', code: 'FIELD_NOT_ALLOWED' });
  });
});

describe('ListAcademicYearsQueryDto', () => {
  it('needs the Institution', async () => {
    expect(await problems(body(ListAcademicYearsQueryDto, { institutionId: uuid }))).toEqual([]);
    expect(await problems(body(ListAcademicYearsQueryDto, {}))).toContainEqual({
      field: 'institutionId',
      code: 'INVALID_FORMAT',
    });
  });
});
