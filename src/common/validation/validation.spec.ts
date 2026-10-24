import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsInt,
  IsNotEmpty,
  IsString,
  Length,
  Max,
  MaxLength,
  ValidateNested,
  validate,
} from 'class-validator';
import { AppException } from '../http/app-exception.js';
import { TrimStringsPipe, createValidationPipe, toFieldErrors } from './validation.js';

class LimitsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  name!: unknown;

  @IsInt()
  @Max(100)
  score!: unknown;

  @IsString()
  @Length(2, 100)
  q!: unknown;

  @ArrayMaxSize(5)
  tags!: unknown;
}

async function errorsFor(values: Partial<Record<keyof LimitsDto, unknown>>) {
  const dto = Object.assign(new LimitsDto(), { name: 'x', score: 1, q: 'ab', tags: [] }, values);
  return toFieldErrors(
    await validate(dto, { validationError: { target: false, value: false } }),
    dto,
  );
}

class GuardianDto {
  @IsString()
  @MaxLength(3)
  name!: unknown;
}

class FamilyDto {
  @IsString()
  @Length(2, 10, { message: 'Pick a name between 2 and 10 characters, longer than a nickname' })
  surname!: unknown;

  @ValidateNested({ each: true })
  @Type(() => GuardianDto)
  guardians!: unknown;
}

async function pipeErrors(body: unknown) {
  try {
    await createValidationPipe().transform(body, { type: 'body', metatype: FamilyDto });
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a validation error');
}

describe('toFieldErrors', () => {
  it('maps constraints to field codes and builds JSON paths', () => {
    const errors: ValidationError[] = [
      { property: 'email', constraints: { isEmail: 'x', isNotEmpty: 'y' }, children: [] },
      { property: 'createdBy', constraints: { whitelistValidation: 'z' }, children: [] },
      {
        property: 'marks',
        children: [
          {
            property: '3',
            children: [{ property: 'obtainedMarks', constraints: { max: 'm' }, children: [] }],
          },
        ],
      },
    ];
    expect(toFieldErrors(errors)).toEqual([
      { field: 'email', code: 'REQUIRED', message: 'This field is required' },
      { field: 'createdBy', code: 'FIELD_NOT_ALLOWED', message: 'This field is not allowed' },
      {
        field: 'marks[3].obtainedMarks',
        code: 'OUT_OF_RANGE',
        message: 'A value is out of the allowed range',
      },
    ]);
  });

  it('uses a code from the decorator context when one is given', () => {
    const errors: ValidationError[] = [
      {
        property: 'amount',
        constraints: { matches: 'x' },
        contexts: { matches: { code: 'MONEY_POSITIVE' } },
        children: [],
      },
    ];
    expect(toFieldErrors(errors)[0]?.code).toBe('MONEY_POSITIVE');
  });

  it('tells too short from too long for @Length, and uses the API codes for arrays and code lists', () => {
    const errors: ValidationError[] = [
      {
        property: 'name',
        constraints: { isLength: 'name must be longer than or equal to 2 characters' },
      },
      {
        property: 'note',
        constraints: { isLength: 'note must be shorter than or equal to 500 characters' },
      },
      { property: 'guardians', constraints: { arrayMinSize: 'x' } },
      { property: 'tags', constraints: { arrayMaxSize: 'x' } },
      { property: 'gender', constraints: { isIn: 'x' } },
    ];
    expect(toFieldErrors(errors).map((e) => e.code)).toEqual([
      'TOO_SHORT',
      'TOO_LONG',
      'TOO_FEW',
      'TOO_MANY',
      'INVALID_CODE',
    ]);
  });
});

describe('toFieldErrors with real decorators', () => {
  it('reports a wrong type as INVALID_TYPE before any length rule', async () => {
    const errors = await errorsFor({ name: 123 });
    expect(errors).toEqual([expect.objectContaining({ field: 'name', code: 'INVALID_TYPE' })]);
  });

  it('carries the limit as params (API design 12.1)', async () => {
    const errors = await errorsFor({
      name: 'x'.repeat(21),
      score: 101,
      q: 'a',
      tags: [1, 2, 3, 4, 5, 6],
    });
    expect(errors.map(({ field, code, params }) => ({ field, code, params }))).toEqual([
      { field: 'name', code: 'TOO_LONG', params: { max: 20 } },
      { field: 'score', code: 'OUT_OF_RANGE', params: { max: 100 } },
      { field: 'q', code: 'TOO_SHORT', params: { min: 2 } },
      { field: 'tags', code: 'TOO_MANY', params: { max: 5 } },
    ]);
  });
});

describe('the validation pipe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never attaches the DTO or its values to a validation error (SDD 17.1)', async () => {
    // `validate` is protected; the spy sees what class-validator returned.
    const proto = ValidationPipe.prototype as unknown as {
      validate: (object: object) => Promise<ValidationError[]>;
    };
    const validateSpy = vi.spyOn(proto, 'validate');
    await pipeErrors({ surname: 'x', guardians: [{ name: 'Ananya' }] });
    const raw = await validateSpy.mock.results[0]?.value;
    expect(raw.length).toBeGreaterThan(0);
    expect(JSON.stringify(raw)).not.toMatch(/Ananya|"target"|"value"/);
  });

  it('still carries params, for nested objects too', async () => {
    const error = await pipeErrors({ surname: 'x', guardians: [{ name: 'Ananya' }] });
    expect(
      error.options.errors?.map(({ field, code, params }) => ({ field, code, params })),
    ).toEqual([
      { field: 'surname', code: 'TOO_SHORT', params: { min: 2 } },
      { field: 'guardians[0].name', code: 'TOO_LONG', params: { max: 3 } },
    ]);
  });

  it('decides too short or too long from the length, not the message', async () => {
    const error = await pipeErrors({ surname: 'x'.repeat(11), guardians: [] });
    expect(error.options.errors?.[0]).toMatchObject({ field: 'surname', code: 'TOO_LONG' });
  });
});

describe('TrimStringsPipe', () => {
  const pipe = new TrimStringsPipe();

  it('trims Express 5 query objects, which have a null prototype', () => {
    const query = Object.assign(Object.create(null) as Record<string, unknown>, {
      q: '  vidya ',
      status: [' 1', '2 '],
    });
    expect(pipe.transform(query, { type: 'query' })).toEqual({ q: 'vidya', status: ['1', '2'] });
  });

  it('leaves route params alone', () => {
    expect(pipe.transform(' id ', { type: 'param' })).toBe(' id ');
  });
});

describe('TrimStringsPipe reserved keys', () => {
  const pipe = new TrimStringsPipe();

  it('refuses __proto__ and constructor keys, with their paths', () => {
    const body = JSON.parse('{"name":"x","__proto__":{"a":1},"items":[{"constructor":1}]}');
    let thrown: unknown;
    try {
      pipe.transform(body, { type: 'body' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppException);
    expect((thrown as AppException).options.errors?.map((e) => [e.field, e.code])).toEqual([
      ['__proto__', 'FIELD_NOT_ALLOWED'],
      ['items[0].constructor', 'FIELD_NOT_ALLOWED'],
    ]);
  });
});
