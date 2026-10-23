import type { ValidationError } from '@nestjs/common';
import { toFieldErrors } from './validation.js';

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
});
