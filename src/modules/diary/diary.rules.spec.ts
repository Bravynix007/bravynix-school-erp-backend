import { AppException } from '../../common/http/app-exception.js';
import { MAX_BACKDATE_DAYS, requireDiaryDate } from './diary.rules.js';

const year = { startDate: '2026-06-01', endDate: '2027-03-31' };
const TODAY = '2026-11-17';

const refusal = (date: string, span = year, today = TODAY) => {
  try {
    requireDiaryDate(date, today, span);
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  return undefined;
};

describe('requireDiaryDate', () => {
  it('takes today and every day up to the limit back', () => {
    expect(MAX_BACKDATE_DAYS).toBe(7);
    expect(refusal(TODAY)).toBeUndefined();
    expect(refusal('2026-11-10')).toBeUndefined();
  });

  it('refuses a day that has not come, and a day further back than the limit', () => {
    expect(refusal('2026-11-18')).toEqual({ status: 422, code: 'DATE_IN_FUTURE' });
    expect(refusal('2026-11-09')).toEqual({ status: 422, code: 'DATE_TOO_OLD' });
  });

  it('counts the days back across a month and a year', () => {
    expect(refusal('2026-12-26', year, '2027-01-02')).toBeUndefined();
    expect(refusal('2026-12-25', year, '2027-01-02')).toEqual({
      status: 422,
      code: 'DATE_TOO_OLD',
    });
  });

  it('refuses a day outside the year, after the other two rules', () => {
    expect(refusal('2026-05-30', year, '2026-06-03')).toEqual({
      status: 422,
      code: 'DATE_OUTSIDE_CURRENT_YEAR',
    });
    expect(refusal('2026-05-30', year, '2026-11-17')).toEqual({
      status: 422,
      code: 'DATE_TOO_OLD',
    });
    expect(refusal('2027-04-02', year, '2027-04-03')).toEqual({
      status: 422,
      code: 'DATE_OUTSIDE_CURRENT_YEAR',
    });
  });
});
