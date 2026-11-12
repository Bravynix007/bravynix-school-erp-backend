import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';

/** 1 Silver, 2 Gold, 3 Platinum (PRD 7.6). */
export const ACHIEVEMENT_TIERS = [1, 2, 3] as const;

/** ACH-02 body: the star's tier and what it is for. */
export class CreateAchievementDto {
  @ApiProperty({ enum: ACHIEVEMENT_TIERS, description: '1 Silver, 2 Gold, 3 Platinum' })
  @IsIn(ACHIEVEMENT_TIERS)
  tier!: 1 | 2 | 3;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;
}

/** ACH-01 query: one year's stars; all of them without it. A query value is a string, so it takes no transform. */
export class ListAchievementsQueryDto {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  academicYearId?: string;
}
