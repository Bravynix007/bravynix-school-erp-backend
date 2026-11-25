import { AppException } from '../../common/http/app-exception.js';
import { requireDates, translateExamError } from './exam.rules.js';

const year = { startDate: '2026-06-01', endDate: '2027-03-31' };

function refusal(run: () => unknown): AppException {
  try {
    run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('Expected a refusal');
}

describe('requireDates', () => {
  it.each([
    ['one day', '2026-08-10', '2026-08-10'],
    ['several days', '2026-08-10', '2026-08-14'],
    ['the first and the last day of the year', '2026-06-01', '2027-03-31'],
  ])('lets %s through', (_label, start, end) => {
    expect(() => requireDates(start, end, year)).not.toThrow();
  });

  it.each([
    ['an end before the start', '2026-08-14', '2026-08-10', ['endDate']],
    ['a start before the year', '2026-05-31', '2026-08-10', ['startDate']],
    ['a start after the year', '2027-04-01', '2027-04-02', ['startDate', 'endDate']],
    ['an end after the year', '2027-03-30', '2027-04-01', ['endDate']],
    ['both before the year', '2026-01-01', '2026-01-05', ['startDate', 'endDate']],
  ])('refuses %s as 400 OUT_OF_RANGE on the date that is wrong', (_label, start, end, fields) => {
    const error = refusal(() => requireDates(start, end, year));
    expect(error.status).toBe(400);
    expect(error.options.errors?.map((e) => [e.field, e.code])).toEqual(
      fields.map((field) => [field, 'OUT_OF_RANGE']),
    );
  });
});

describe('translateExamError', () => {
  it('turns a name already used by an active exam into DUPLICATE on name', () => {
    const error = translateExamError({
      code: '23505',
      constraint: 'uq_exams_year_name',
    }) as AppException;
    expect(error.status).toBe(409);
    expect(error.code).toBe('DUPLICATE');
    expect(error.options.errors?.[0]).toMatchObject({ field: 'name' });
  });

  it('leaves any other error as it is', () => {
    const other = new Error('boom');
    expect(translateExamError(other)).toBe(other);
    expect(translateExamError({ code: '23505', constraint: 'other' })).toEqual({
      code: '23505',
      constraint: 'other',
    });
  });
});
