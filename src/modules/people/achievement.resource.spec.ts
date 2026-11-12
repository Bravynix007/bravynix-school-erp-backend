import type { AchievementRow } from './achievement.repository.js';
import { achievementResource, achievementsResource } from './achievement.resource.js';

const at = new Date('2026-11-12T05:30:00.000Z');
const row = (overrides: Partial<AchievementRow> = {}): AchievementRow =>
  ({
    id: 'star-1',
    created_at: at,
    created_by: 'teacher-1',
    updated_at: at,
    updated_by: null,
    status: 1,
    society_id: 'society-1',
    institution_id: 'institution-1',
    academic_year_id: 'year-1',
    student_enrolment_id: 'enrolment-1',
    student_id: 'student-1',
    tier: 2,
    description: 'Won the quiz',
    awarded_by_staff_member_id: 'staff-1',
    ...overrides,
  }) as AchievementRow;
const people = new Map([
  ['teacher-1', { id: 'teacher-1', displayName: 'Ana Rao', roleName: 'Teacher / Staff' }],
]);

describe('achievementResource', () => {
  it('shows the star, who gave it and when, and nothing of the Institution or the enrolment', () => {
    expect(achievementResource(row(), people)).toEqual({
      id: 'star-1',
      studentId: 'student-1',
      academicYearId: 'year-1',
      tier: 2,
      description: 'Won the quiz',
      awardedByStaffMemberId: 'staff-1',
      createdBy: { id: 'teacher-1', displayName: 'Ana Rao', roleName: 'Teacher / Staff' },
      createdAt: '2026-11-12T05:30:00.000Z',
      updatedBy: { id: null, displayName: 'System', roleName: null },
      updatedAt: '2026-11-12T05:30:00.000Z',
    });
  });

  it('has no staff record for a star an Owner gave', () => {
    expect(
      achievementResource(row({ awarded_by_staff_member_id: null }), people).awardedByStaffMemberId,
    ).toBeNull();
  });
});

describe('achievementsResource', () => {
  it('counts the stars earned by tier and keeps the order it was given', () => {
    const rows = [row({ id: 'a', tier: 3 }), row({ id: 'b', tier: 1 }), row({ id: 'c', tier: 1 })];
    const tab = achievementsResource(rows, people);
    expect(tab.stars).toEqual({ total: 3, silver: 2, gold: 0, platinum: 1 });
    expect(tab.achievements.map((star) => star.id)).toEqual(['a', 'b', 'c']);
  });

  it('is all zeros and an empty list when there is no star', () => {
    expect(achievementsResource([], people)).toEqual({
      stars: { total: 0, silver: 0, gold: 0, platinum: 0 },
      achievements: [],
    });
  });
});
