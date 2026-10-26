import { duplicateOn, isDuplicateOn } from './duplicate.js';

const violation = (constraint: unknown, code = '23505') =>
  Object.assign(new Error('duplicate key'), { code, constraint });

describe('duplicates', () => {
  it('recognises a unique violation of the named constraint, by its prefix', () => {
    expect(isDuplicateOn(violation('uq_societies_code'), 'uq_societies_code')).toBe(true);
    expect(isDuplicateOn(violation('uq_societies_code_ci'), 'uq_societies_code')).toBe(true);
  });

  it('lets any other error through', () => {
    expect(isDuplicateOn(violation('uq_other'), 'uq_societies_code')).toBe(false);
    expect(isDuplicateOn(violation('uq_societies_code', '23503'), 'uq_societies_code')).toBe(false);
    expect(isDuplicateOn(violation(undefined), 'uq_societies_code')).toBe(false);
    expect(isDuplicateOn(null, 'uq_societies_code')).toBe(false);
    expect(isDuplicateOn('boom', 'uq_societies_code')).toBe(false);
  });

  it('names the taken field in a 409 DUPLICATE', () => {
    expect(duplicateOn('code')).toMatchObject({
      status: 409,
      code: 'DUPLICATE',
      options: { errors: [expect.objectContaining({ field: 'code', code: 'DUPLICATE' })] },
    });
  });
});
