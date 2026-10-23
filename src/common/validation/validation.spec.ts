import type { ValidationError } from '@nestjs/common';
import { TrimStringsPipe, toFieldErrors } from './validation.js';

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
