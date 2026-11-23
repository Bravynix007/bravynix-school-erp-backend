import { body, problems } from '../../../test/support/dto-validation.js';
import { CalendarQueryDto } from './student-calendar.dto.js';

describe('CalendarQueryDto', () => {
  it('takes a month written YYYY-MM', async () => {
    expect(await problems(body(CalendarQueryDto, { month: '2026-10' }))).toEqual([]);
  });

  it('refuses a month written any other way or not there', async () => {
    for (const month of ['2026-13', '2026-00', '2026-5', '202610', 'October']) {
      expect(await problems(body(CalendarQueryDto, { month }))).toEqual([
        { field: 'month', code: 'INVALID_FORMAT' },
      ]);
    }
    for (const query of [{}, { month: '' }]) {
      expect(await problems(body(CalendarQueryDto, query))).toEqual([
        { field: 'month', code: 'REQUIRED' },
      ]);
    }
  });
});
