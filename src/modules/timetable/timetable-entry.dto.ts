import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import { LAST_SCHOOL_DAY } from './timetable-entry.rules.js';

/** A staff member by ID, or `me` for the caller's own record. */
const STAFF_OR_ME = /^(me|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * TT-01 query: one week, of a section (`sectionId`), of a teacher (`staffMemberId` and the Institution), or of a
 * parent's own child (`studentId`).
 */
export class ListTimetableQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'The section whose week to read' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({
    description: 'A teacher’s own week at `institutionId`: their staff ID, or `me`',
    example: 'me',
  })
  @IsOptional()
  @IsString()
  @Matches(STAFF_OR_ME)
  staffMemberId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'With `staffMemberId`: the Institution, whose current year is read',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A parent’s own child, whose section’s week is read (parents only)',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  studentId?: string;
}

/** TT-02 body (API design 9.7, 12.6). */
export class CreateTimetableEntryDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  sectionId!: string;

  @ApiProperty({ minimum: 1, maximum: LAST_SCHOOL_DAY, description: '1 Monday to 6 Saturday' })
  @IsInt()
  @Min(1)
  @Max(LAST_SCHOOL_DAY)
  dayOfWeek!: number;

  @ApiProperty({ format: 'uuid', description: 'A period of the Institution’s current year' })
  @LowerCaseUuid()
  @IsUUID()
  timeSlotId!: string;

  @ApiPropertyOptional({ description: 'A break takes no subject and no teacher' })
  @IsOptional()
  @IsBoolean()
  isBreak?: boolean;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required unless a break' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required unless a break' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  staffMemberId?: string;
}

/**
 * TT-03 body: an omitted field stays. Making the entry a break clears the subject and the teacher; making it a lesson
 * needs both. The section is not editable.
 */
export class UpdateTimetableEntryDto extends VersionDto {
  @ApiPropertyOptional({ minimum: 1, maximum: LAST_SCHOOL_DAY })
  @WhenPresent()
  @IsInt()
  @Min(1)
  @Max(LAST_SCHOOL_DAY)
  dayOfWeek?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @WhenPresent()
  @LowerCaseUuid()
  @IsUUID()
  timeSlotId?: string;

  @ApiPropertyOptional()
  @WhenPresent()
  @IsBoolean()
  isBreak?: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  @WhenPresent()
  @LowerCaseUuid()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @WhenPresent()
  @LowerCaseUuid()
  @IsUUID()
  staffMemberId?: string;
}
