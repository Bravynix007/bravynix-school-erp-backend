import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateSubjectDto, UpdateSubjectDto } from './subject.dto.js';

describe('CreateSubjectDto', () => {
  it('takes a name, with a code or without, or with the code null', async () => {
    expect(await problems(body(CreateSubjectDto, { name: 'Mathematics' }))).toEqual([]);
    expect(await problems(body(CreateSubjectDto, { name: 'Mathematics', code: 'MATH' }))).toEqual(
      [],
    );
    expect(await problems(body(CreateSubjectDto, { name: 'Mathematics', code: null }))).toEqual([]);
  });

  it.each([
    [{}, 'name', 'INVALID_TYPE'],
    [{ name: '' }, 'name', 'TOO_SHORT'],
    [{ name: 'x'.repeat(101) }, 'name', 'TOO_LONG'],
    [{ name: 12 }, 'name', 'INVALID_TYPE'],
    [{ name: 'Maths', code: '' }, 'code', 'TOO_SHORT'],
    [{ name: 'Maths', code: 'x'.repeat(51) }, 'code', 'TOO_LONG'],
    [{ name: 'Maths', code: 5 }, 'code', 'INVALID_TYPE'],
    [{ name: 'Maths', societyId: 'x' }, 'societyId', 'FIELD_NOT_ALLOWED'],
    [{ name: 'Maths', status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateSubjectDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateSubjectDto', () => {
  it('needs the version, and takes either field or neither', async () => {
    expect(await problems(body(UpdateSubjectDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(body(UpdateSubjectDto, { version: 2, name: 'Maths', code: 'M' })),
    ).toEqual([]);
    expect(await problems(body(UpdateSubjectDto, { version: 2, code: null }))).toEqual([]);
    expect(await problems(body(UpdateSubjectDto, { name: 'Maths' }))).toContainEqual({
      field: 'version',
      code: 'INVALID_TYPE',
    });
  });

  it.each([
    [{ version: 1, name: null }, 'name', 'INVALID_TYPE'],
    [{ version: 1, name: '' }, 'name', 'TOO_SHORT'],
    [{ version: 1, code: '' }, 'code', 'TOO_SHORT'],
    [{ version: '1', name: 'x' }, 'version', 'INVALID_TYPE'],
    [{ version: 1, status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(UpdateSubjectDto, value))).toContainEqual({ field, code });
  });
});
