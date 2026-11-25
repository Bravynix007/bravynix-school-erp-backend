import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateExamDto, ListExamsQueryDto, UpdateExamDto } from './exam.dto.js';

const uuid = '0192f3b0-0000-7000-8000-000000000001';
const valid = {
  institutionId: uuid,
  name: 'Unit Test 1',
  examType: 1,
  startDate: '2026-08-10',
  endDate: '2026-08-14',
};

describe('CreateExamDto', () => {
  it('takes the required fields, and a year', async () => {
    expect(await problems(body(CreateExamDto, valid))).toEqual([]);
    expect(await problems(body(CreateExamDto, { ...valid, academicYearId: uuid }))).toEqual([]);
    expect(await problems(body(CreateExamDto, { ...valid, examType: 6 }))).toEqual([]);
  });

  it.each([
    [{ ...valid, institutionId: undefined }, 'institutionId', 'REQUIRED'],
    [{ ...valid, name: undefined }, 'name', 'REQUIRED'],
    [{ ...valid, name: '   ' }, 'name', 'INVALID_FORMAT'],
    [{ ...valid, name: 'x'.repeat(101) }, 'name', 'TOO_LONG'],
    [{ ...valid, name: 7 }, 'name', 'INVALID_TYPE'],
    [{ ...valid, examType: undefined }, 'examType', 'REQUIRED'],
    [{ ...valid, examType: 0 }, 'examType', 'INVALID_CODE'],
    [{ ...valid, examType: 7 }, 'examType', 'INVALID_CODE'],
    [{ ...valid, examType: '1' }, 'examType', 'INVALID_TYPE'],
    [{ ...valid, startDate: undefined }, 'startDate', 'REQUIRED'],
    [{ ...valid, startDate: '2026-8-10' }, 'startDate', 'INVALID_FORMAT'],
    [{ ...valid, endDate: '2027-02-29' }, 'endDate', 'INVALID_FORMAT'],
    [{ ...valid, academicYearId: 'not-a-uuid' }, 'academicYearId', 'INVALID_FORMAT'],
    [{ ...valid, status: 0 }, 'status', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CreateExamDto, value))).toContainEqual({ field, code });
  });
});

describe('UpdateExamDto', () => {
  it('needs the version, and takes any of the fields', async () => {
    expect(await problems(body(UpdateExamDto, { version: 1 }))).toEqual([]);
    expect(
      await problems(
        body(UpdateExamDto, {
          version: 2,
          name: 'Term 1',
          examType: 5,
          startDate: '2026-09-21',
          endDate: '2026-09-30',
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [{}, 'version', 'REQUIRED'],
    [{ version: 1, name: null }, 'name', 'INVALID_TYPE'],
    [{ version: 1, examType: null }, 'examType', 'INVALID_TYPE'],
    [{ version: 1, examType: 9 }, 'examType', 'INVALID_CODE'],
    [{ version: 1, startDate: null }, 'startDate', 'INVALID_TYPE'],
    [{ version: 1, endDate: '10/08/2026' }, 'endDate', 'INVALID_FORMAT'],
    [{ version: 1, institutionId: uuid }, 'institutionId', 'FIELD_NOT_ALLOWED'],
    [{ version: 1, academicYearId: uuid }, 'academicYearId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(UpdateExamDto, value))).toContainEqual({ field, code });
  });
});

describe('ListExamsQueryDto', () => {
  it('takes an Institution, a year and a child, each optional', async () => {
    expect(await problems(body(ListExamsQueryDto, {}))).toEqual([]);
    expect(
      await problems(
        body(ListExamsQueryDto, { institutionId: uuid, academicYearId: uuid, studentId: uuid }),
      ),
    ).toEqual([]);
  });

  it('refuses an ID that is not one', async () => {
    expect(await problems(body(ListExamsQueryDto, { institutionId: 'x' }))).toContainEqual({
      field: 'institutionId',
      code: 'INVALID_FORMAT',
    });
  });
});
