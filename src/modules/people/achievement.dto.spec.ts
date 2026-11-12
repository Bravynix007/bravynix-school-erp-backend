import { body, problems } from '../../../test/support/dto-validation.js';
import { CreateAchievementDto, ListAchievementsQueryDto } from './achievement.dto.js';

describe('CreateAchievementDto', () => {
  it.each([1, 2, 3])('takes tier %s and a description', async (tier) => {
    expect(
      await problems(body(CreateAchievementDto, { tier, description: 'Won the quiz' })),
    ).toEqual([]);
  });

  it('takes a description of 500 characters', async () => {
    expect(
      await problems(body(CreateAchievementDto, { tier: 1, description: 'x'.repeat(500) })),
    ).toEqual([]);
  });

  it.each([
    ['no tier', { description: 'Quiz' }, 'tier', 'INVALID_CODE'],
    ['tier 0', { tier: 0, description: 'Quiz' }, 'tier', 'INVALID_CODE'],
    ['tier 4', { tier: 4, description: 'Quiz' }, 'tier', 'INVALID_CODE'],
    ['a tier as text', { tier: '2', description: 'Quiz' }, 'tier', 'INVALID_CODE'],
    ['no description', { tier: 1 }, 'description', 'INVALID_TYPE'],
    ['an empty description', { tier: 1, description: '' }, 'description', 'TOO_SHORT'],
    ['a description of 501', { tier: 1, description: 'x'.repeat(501) }, 'description', 'TOO_LONG'],
    [
      'a field that is not the star’s',
      { tier: 1, description: 'Quiz', studentId: 'x' },
      'studentId',
      'FIELD_NOT_ALLOWED',
    ],
  ])('refuses %s', async (_name, fields, field, code) => {
    expect(await problems(body(CreateAchievementDto, fields))).toContainEqual({ field, code });
  });
});

describe('ListAchievementsQueryDto', () => {
  const year = '0192f3b0-0000-7000-8000-000000000001';

  it('takes no year, or a year in either case', async () => {
    expect(await problems(body(ListAchievementsQueryDto, {}))).toEqual([]);
    const upper = await body(ListAchievementsQueryDto, { academicYearId: year.toUpperCase() });
    expect(upper.academicYearId).toBe(year);
  });

  it('refuses a year that is not an id', async () => {
    expect(await problems(body(ListAchievementsQueryDto, { academicYearId: 'x' }))).toContainEqual({
      field: 'academicYearId',
      code: 'INVALID_FORMAT',
    });
  });
});
