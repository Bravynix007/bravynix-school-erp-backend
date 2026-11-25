import { academicYears } from './academic-seed.js';
import { examsOfTheYear, gradeScale } from './exams-seed.js';

describe('the exams seed', () => {
  it('holds every exam inside the seeded year, the end not before the start', () => {
    const { startDate, endDate } = academicYears[0]!;
    for (const exam of examsOfTheYear) {
      expect(exam.startDate >= startDate && exam.endDate <= endDate).toBe(true);
      expect(exam.endDate >= exam.startDate).toBe(true);
    }
  });

  it('names each exam once, in any letter case', () => {
    const names = examsOfTheYear.map((e) => e.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('grades on a scale with no gap and no overlap, down to a hundredth', () => {
    const bands = gradeScale.toSorted((a, b) => a.minPercentage - b.minPercentage);
    expect(bands[0]!.minPercentage).toBe(0);
    expect(bands.at(-1)!.maxPercentage).toBe(100);
    for (const [i, band] of bands.slice(1).entries()) {
      expect(Math.round((band.minPercentage - bands[i]!.maxPercentage) * 100)).toBe(1);
    }
  });
});
