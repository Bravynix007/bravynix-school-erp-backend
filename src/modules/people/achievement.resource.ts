import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { AchievementRow } from './achievement.repository.js';

/** One star on a student's Achievements tab: "By <teacher>" is `createdBy`, the date and time `createdAt`. */
export interface AchievementResource extends AuthorStamps {
  id: string;
  studentId: string;
  academicYearId: string;
  /** 1 Silver, 2 Gold, 3 Platinum. */
  tier: number;
  description: string;
  /** The staff record that gave it; `null` when a Society Owner did. */
  awardedByStaffMemberId: string | null;
}

/** The tab: Stars Earned (the count of the stars shown, by tier) and the stars, newest first. */
export interface AchievementsResource {
  stars: { total: number; silver: number; gold: number; platinum: number };
  achievements: AchievementResource[];
}

export function achievementResource(
  row: AchievementRow,
  people: ReadonlyMap<string, AuthorRef>,
): AchievementResource {
  return {
    id: row.id,
    studentId: row.student_id,
    academicYearId: row.academic_year_id,
    tier: row.tier,
    description: row.description,
    awardedByStaffMemberId: row.awarded_by_staff_member_id,
    ...authorStamps(row, people),
  };
}

export function achievementsResource(
  rows: readonly AchievementRow[],
  people: ReadonlyMap<string, AuthorRef>,
): AchievementsResource {
  const count = (tier: number) => rows.filter((row) => row.tier === tier).length;
  return {
    stars: { total: rows.length, silver: count(1), gold: count(2), platinum: count(3) },
    achievements: rows.map((row) => achievementResource(row, people)),
  };
}
