import { compareRollNumbers, oldPlacementEnd, outcomeOf, renumber } from './promotion.rules.js';

describe('outcomeOf', () => {
  it('is Promoted for another class, Repeating for the same one, Completed for none', () => {
    expect(outcomeOf('class-5', 'class-6')).toBe(1);
    expect(outcomeOf('class-5', 'class-5')).toBe(2);
    expect(outcomeOf('class-12', null)).toBe(4);
  });
});

describe('oldPlacementEnd', () => {
  it('is the last day of the old year', () => {
    expect(oldPlacementEnd('2025-06-01', '2026-03-31')).toBe('2026-03-31');
  });

  it('is never before the placement began', () => {
    expect(oldPlacementEnd('2026-04-10', '2026-03-31')).toBe('2026-04-10');
  });
});

describe('compareRollNumbers', () => {
  it('puts numbers in numeric order before the rest', () => {
    expect(['10', 'A1', '9', 'a0', '2'].toSorted(compareRollNumbers)).toEqual([
      '2',
      '9',
      '10',
      'a0',
      'A1',
    ]);
  });
});

describe('renumber', () => {
  it('numbers the old rolls in class-list order from 1 in an empty section', () => {
    expect(renumber(['10', '2', '9'], [])).toEqual(['3', '1', '2']);
  });

  it('carries on after the highest number the section holds', () => {
    expect(renumber(['5', '4'], ['1', '7', 'X'])).toEqual(['9', '8']);
  });

  it('keeps the order of equal rolls', () => {
    expect(renumber(['1', '1'], [])).toEqual(['1', '2']);
  });

  it('answers nothing for nobody', () => {
    expect(renumber([], ['3'])).toEqual([]);
  });
});
