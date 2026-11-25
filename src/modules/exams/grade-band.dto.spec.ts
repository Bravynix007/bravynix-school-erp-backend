import { body, problems } from '../../../test/support/dto-validation.js';
import {
  CreateGradeBandDto,
  ListGradeBandsQueryDto,
  UpdateGradeBandDto,
} from './grade-band.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const valid = { institutionId: uuid, name: 'A1', minPercentage: 91, maxPercentage: 100 };

describe('CreateGradeBandDto', () => {
  it('takes the required fields, and the optional ones', async () => {
    expect(await problems(body(CreateGradeBandDto, valid))).toEqual([]);
    expect(
      await problems(
        body(CreateGradeBandDto, {
          ...valid,
          minPercentage: 90.5,
          maxPercentage: 99.99,
          gradePoint: 9.5,
          description: 'Outstanding',
        }),
      ),
    ).toEqual([]);
    expect(
      await problems(body(CreateGradeBandDto, { ...valid, gradePoint: null, description: null })),
    ).toEqual([]);
  });

  it.each([
    [{ ...valid, institutionId: undefined }, 'institutionId', 'REQUIRED'],
    [{ ...valid, name: undefined }, 'name', 'REQUIRED'],
    [{ ...valid, name: 'x'.repeat(21) }, 'name', 'TOO_LONG'],
    [{ ...valid, name: 7 }, 'name', 'INVALID_TYPE'],
    [{ ...valid, minPercentage: undefined }, 'minPercentage', 'REQUIRED'],
    [{ ...valid, minPercentage: -0.01 }, 'minPercentage', 'OUT_OF_RANGE'],
    [{ ...valid, maxPercentage: 100.01 }, 'maxPercentage', 'OUT_OF_RANGE'],
    [{ ...valid, minPercentage: '91' }, 'minPercentage', 'INVALID_TYPE'],
    [{ ...valid, minPercentage: 91.001 }, 'minPercentage', 'INVALID_TYPE'],
    [{ ...valid, maxPercentage: Number.NaN }, 'maxPercentage', 'INVALID_TYPE'],
    [{ ...valid, gradePoint: 10.01 }, 'gradePoint', 'OUT_OF_RANGE'],
    [{ ...valid, gradePoint: -1 }, 'gradePoint', 'OUT_OF_RANGE'],
    [{ ...valid, description: 'x'.repeat(101) }, 'description', 'TOO_LONG'],
    [{ ...valid, academicYearId: uuid }, 'academicYearId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateGradeBandDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateGradeBandDto', () => {
  it('needs the version, and takes any of the fields', async () => {
    expect(await problems(body(UpdateGradeBandDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateGradeBandDto, {
          version: 2,
          name: 'A',
          minPercentage: 0,
          maxPercentage: 100,
          gradePoint: null,
          description: null,
        }),
      ),
    ).toEqual([]);
    expect(await problems(body(UpdateGradeBandDto, { name: 'x' }))).toContainEqual({
      field: 'version',
      code: 'REQUIRED',
    });
  });

  it.each([
    [{ version: 1, name: null }, 'name', 'INVALID_TYPE'],
    [{ version: 1, minPercentage: null }, 'minPercentage', 'INVALID_TYPE'],
    [{ version: 1, maxPercentage: null }, 'maxPercentage', 'INVALID_TYPE'],
    [{ version: 1, institutionId: uuid }, 'institutionId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(UpdateGradeBandDto, value))).toContainEqual({ field, code });
  });
});

describe('ListGradeBandsQueryDto', () => {
  it('takes an Institution or a child, both optional here', async () => {
    expect(await problems(body(ListGradeBandsQueryDto, {}))).toEqual([]);
    expect(await problems(body(ListGradeBandsQueryDto, { institutionId: uuid }))).toEqual([]);
    expect(await problems(body(ListGradeBandsQueryDto, { studentId: 'x' }))).toContainEqual({
      field: 'studentId',
      code: 'INVALID_FORMAT',
    });
  });
});
