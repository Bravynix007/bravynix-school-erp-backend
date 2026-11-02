import { body, problems } from '../../../test/support/dto-validation.js';
import { MASTER_SPECS, MASTER_TYPES } from './master.catalog.js';
import {
  CreateCityDto,
  CreateClassCategoryDto,
  CreateCountryDto,
  CreateDesignationDto,
  CreatePredefinedClassDto,
  CreatePredefinedSectionDto,
  CreateStateDto,
  MasterQueryDto,
  UpdateClassCategoryDto,
  UpdateCountryDto,
  UpdateDesignationDto,
  UpdatePredefinedClassDto,
  UpdateStateDto,
} from './master.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';

describe('the bodies of PLT-31', () => {
  it('take the required fields alone', async () => {
    expect(await problems(body(CreateCountryDto, { name: 'India', iso2: 'IN' }))).toEqual([]);
    expect(await problems(body(CreateStateDto, { countryId: uuid, name: 'Goa' }))).toEqual([]);
    expect(await problems(body(CreateCityDto, { stateId: uuid, name: 'Panaji' }))).toEqual([]);
    expect(
      await problems(body(CreateClassCategoryDto, { code: 'PRE_SCHOOL', name: 'Pre-School' })),
    ).toEqual([]);
    expect(
      await problems(
        body(CreatePredefinedClassDto, {
          classCategoryId: uuid,
          code: 'C01',
          name: '1st',
          numericValue: 1,
          displayOrder: 4,
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [CreateCountryDto, { name: 'India', iso2: 'in' }, 'iso2', 'INVALID_FORMAT'],
    [CreateCountryDto, { name: 'India', iso2: 'IND' }, 'iso2', 'INVALID_FORMAT'],
    [
      CreateCountryDto,
      { name: 'India', iso2: 'IN', currency: 'inr' },
      'currency',
      'INVALID_FORMAT',
    ],
    [
      CreateCountryDto,
      { name: 'India', iso2: 'IN', phoneCode: '+91' },
      'phoneCode',
      'INVALID_FORMAT',
    ],
    [CreateCountryDto, { name: 'x'.repeat(101), iso2: 'IN' }, 'name', 'TOO_LONG'],
    [CreateStateDto, { countryId: 'nope', name: 'Goa' }, 'countryId', 'INVALID_FORMAT'],
    [CreateStateDto, { name: 'Goa' }, 'countryId', 'INVALID_FORMAT'],
    [CreateCityDto, { stateId: uuid, name: '' }, 'name', 'TOO_SHORT'],
    [CreateClassCategoryDto, { code: 'pre school', name: 'x' }, 'code', 'INVALID_FORMAT'],
    [CreateClassCategoryDto, { code: '1ST', name: 'x' }, 'code', 'INVALID_FORMAT'],
    [
      CreateClassCategoryDto,
      { code: 'A', name: 'x', displayOrder: '3' },
      'displayOrder',
      'INVALID_TYPE',
    ],
    [
      CreateClassCategoryDto,
      { code: 'A', name: 'x', displayOrder: 0 },
      'displayOrder',
      'OUT_OF_RANGE',
    ],
    [CreateClassCategoryDto, { code: 'A', name: 'x', status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
    [
      CreateClassCategoryDto,
      { code: 'A', name: 'x', createdBy: uuid },
      'createdBy',
      'FIELD_NOT_ALLOWED',
    ],
    [
      CreatePredefinedClassDto,
      { classCategoryId: uuid, code: 'A', name: 'x', numericValue: 100 },
      'numericValue',
      'OUT_OF_RANGE',
    ],
    [
      CreatePredefinedClassDto,
      { classCategoryId: uuid, code: 'A', name: 'x', numericValue: '5' },
      'numericValue',
      'INVALID_TYPE',
    ],
  ] as [new () => object, unknown, string, string][])(
    'refuse %j',
    async (dto, value, field, code) => {
      expect(await problems(body(dto, value))).toContainEqual({ field, code });
    },
  );

  it('let a section code start with a digit, and an optional field be cleared with null', async () => {
    expect(await problems(body(CreatePredefinedSectionDto, { code: '1', name: '1' }))).toEqual([]);
    expect(
      await problems(
        body(CreateCountryDto, { name: 'India', iso2: 'IN', phoneCode: null, currency: null }),
      ),
    ).toEqual([]);
  });
});

describe('the bodies of PLT-32', () => {
  it('need the version, as a whole number (a text "1" is not one)', async () => {
    expect(await problems(body(UpdateStateDto, { name: 'Goa' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
    expect(await problems(body(UpdateStateDto, { version: '1' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
    expect(await problems(body(UpdateStateDto, { version: 1 }))).toEqual([]);
  });

  it('leave out what is fixed once an entry is added', async () => {
    expect(await problems(body(UpdateClassCategoryDto, { version: 1, code: 'X' }))).toContainEqual({
      field: 'code',
      code: 'FIELD_NOT_ALLOWED',
    });
    expect(await problems(body(UpdateStateDto, { version: 1, countryId: uuid }))).toContainEqual({
      field: 'countryId',
      code: 'FIELD_NOT_ALLOWED',
    });
    expect(await problems(body(UpdateCountryDto, { version: 1, iso2: 'IN' }))).toContainEqual({
      field: 'iso2',
      code: 'FIELD_NOT_ALLOWED',
    });
    expect(
      await problems(body(UpdatePredefinedClassDto, { version: 1, classCategoryId: uuid })),
    ).toContainEqual({ field: 'classCategoryId', code: 'FIELD_NOT_ALLOWED' });
  });

  it('take a new position and hide or show with status 0 or 1', async () => {
    expect(
      await problems(body(UpdateClassCategoryDto, { version: 2, displayOrder: 1, status: 0 })),
    ).toEqual([]);
    expect(await problems(body(UpdateClassCategoryDto, { version: 2, status: 2 }))).toContainEqual({
      field: 'status',
      code: 'INVALID_CODE',
    });
    expect(
      await problems(body(UpdateClassCategoryDto, { version: 2, displayOrder: 0 })),
    ).toContainEqual({ field: 'displayOrder', code: 'OUT_OF_RANGE' });
  });

  it('clear an optional field with null', async () => {
    expect(
      await problems(body(UpdateCountryDto, { version: 1, phoneCode: null, currency: null })),
    ).toEqual([]);
    expect(
      await problems(body(UpdatePredefinedClassDto, { version: 1, numericValue: null })),
    ).toEqual([]);
  });
});

describe('null on a field that cannot be empty', () => {
  it.each([
    [UpdateDesignationDto, 'name'],
    [UpdateDesignationDto, 'status'],
    [UpdateDesignationDto, 'displayOrder'],
    [UpdateCountryDto, 'name'],
    [UpdateStateDto, 'status'],
    [UpdatePredefinedClassDto, 'displayOrder'],
  ] as const)('is INVALID_TYPE on an edit of %j: %s', async (dto, field) => {
    expect(await problems(body(dto, { version: 1, [field]: null }))).toContainEqual({
      field,
      code: 'INVALID_TYPE',
    });
  });

  it('is INVALID_TYPE for displayOrder on an add', async () => {
    expect(
      await problems(
        body(CreateDesignationDto, { code: 'TEACHER', name: 'Teacher', displayOrder: null }),
      ),
    ).toContainEqual({ field: 'displayOrder', code: 'INVALID_TYPE' });
  });
});

describe('names', () => {
  it('take one space for any run of white space inside them, on an add and on an edit', async () => {
    const added = await body(CreateDesignationDto, {
      code: 'TEACHER',
      name: 'Head  of\tthe\u00a0School',
    });
    expect(added.name).toBe('Head of the School');
    const edited = await body(UpdateDesignationDto, { version: 1, name: 'Vice   Principal' });
    expect(edited.name).toBe('Vice Principal');
  });

  it('are still refused when they are not text', async () => {
    expect(await problems(body(CreateDesignationDto, { code: 'TEACHER', name: 5 }))).toContainEqual(
      { field: 'name', code: 'INVALID_TYPE' },
    );
  });
});

describe('the query of MST-01', () => {
  it('converts includeHidden from text and refuses anything else', async () => {
    const yes = await body(MasterQueryDto, { includeHidden: 'true' });
    expect(yes.includeHidden).toBe(true);
    expect(await problems(body(MasterQueryDto, { includeHidden: 'maybe' }))).toContainEqual({
      field: 'includeHidden',
      code: 'INVALID_TYPE',
    });
    expect(await problems(body(MasterQueryDto, { stateId: 'nope' }))).toContainEqual({
      field: 'stateId',
      code: 'INVALID_FORMAT',
    });
    expect(await problems(body(MasterQueryDto, { limit: 5 }))).toContainEqual({
      field: 'limit',
      code: 'FIELD_NOT_ALLOWED',
    });
  });
});

describe('the catalogue', () => {
  it.each(MASTER_TYPES)('describes %s consistently', (type) => {
    const spec = MASTER_SPECS[type];
    expect(spec.type).toBe(type);
    const columns = spec.fields.map(({ column }) => column);
    expect(new Set(columns).size).toBe(columns.length);
    // An ordered list shows its position; a list by name does not.
    expect(columns.includes('display_order')).toBe(spec.ordered);
    // A parent is a field of the entry.
    expect(!spec.parent || spec.fields.some(({ api }) => api === spec.parent!.field)).toBe(true);
    // A deferred order constraint only exists where the list is ordered.
    expect(!spec.orderConstraint || spec.ordered).toBe(true);
  });
});
