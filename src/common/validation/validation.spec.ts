import type { ValidationError } from '@nestjs/common';
import {
  ArrayMaxSize,
  IsInt,
  IsNotEmpty,
  IsString,
  Length,
  Max,
  MaxLength,
  validate,
} from 'class-validator';
import { AppException } from '../http/app-exception.js';
import { TrimStringsPipe, toFieldErrors } from './validation.js';

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
  return toFieldErrors(await validate(dto, { validationError: { target: true, value: false } }));
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
