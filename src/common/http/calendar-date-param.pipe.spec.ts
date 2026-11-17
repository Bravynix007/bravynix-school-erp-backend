import { CalendarDateParamPipe } from './calendar-date-param.pipe.js';

describe('CalendarDateParamPipe', () => {
  const pipe = new CalendarDateParamPipe();

  it('passes a real date', () => {
    expect(pipe.transform('2026-11-17')).toBe('2026-11-17');
    expect(pipe.transform('2028-02-29')).toBe('2028-02-29');
  });

  it.each(['', 'today', '2026-11-1', '2026-13-01', '2027-02-29', '2026-11-17T00:00', '17-11-2026'])(
    'is 400 INVALID_FORMAT on date for %j',
    (value) => {
      expect(() => pipe.transform(value)).toThrow(
        expect.objectContaining({
          status: 400,
          options: expect.objectContaining({
            errors: [expect.objectContaining({ field: 'date', code: 'INVALID_FORMAT' })],
          }) as unknown,
        }),
      );
    },
  );
});
