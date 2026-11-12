import { describe, expect, it } from 'vitest';
import { placementStart } from './student.service.js';

// QA: the first day of a new student's enrolment and placement stays inside the academic year (B6a QA D1).
const inYear = (admissionDate: string | null, today = '2026-11-11'): string =>
  placementStart(admissionDate, today, '2026-06-01', '2027-03-31');

describe('placementStart (QA)', () => {
  it('keeps an admission date inside the year', () =>
    expect(inYear('2026-07-15')).toBe('2026-07-15'));
  it('starts the year for an admission date years before it', () =>
    expect(inYear('2020-01-01')).toBe('2026-06-01'));
  it('refuses an admission date after the year ends', () =>
    expect(() => inYear('2027-09-01')).toThrow('VALIDATION_FAILED'));
  it('uses today inside the year', () => expect(inYear(null)).toBe('2026-11-11'));
  it('uses the first day of a year that has not begun', () =>
    expect(placementStart(null, '2026-11-11', '2027-06-01', '2028-03-31')).toBe('2027-06-01'));
  it('uses the last day when today is past an open year', () =>
    expect(inYear(null, '2027-05-01')).toBe('2027-03-31'));
});
