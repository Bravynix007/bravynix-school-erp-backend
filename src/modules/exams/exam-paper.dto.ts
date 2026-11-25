import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { BooleanQuery } from '../../common/validation/boolean-query.js';
import { IsCalendarDate } from '../../common/validation/calendar-date.js';
import { IsClockTime } from '../../common/validation/clock-time.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { NotBlank } from '../../common/validation/not-blank.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import { MAX_MARKS_CEILING } from './exam-paper.rules.js';

/**
 * EXM-05 query: one section's papers, or a parent's own child, whose section's papers are read (parents only; a
 * parent sees the datesheet once it is published).
 */
export class ListExamPapersQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only this section’s papers; every section’s when left out (not for a parent)',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A parent’s own child, whose section’s papers are read (parents only)',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  studentId?: string;
}

/**
 * EXM-10 query: the Institution, one of its academic years (the current year when left out), and whose papers: the
 * caller's own (`mine`), or one staff member's by their ID (an Admin or Owner; a teacher only their own).
 */
export class ListMyExamPapersQueryDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  institutionId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'An academic year of `institutionId`; the current year when left out',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({ description: 'The caller’s own papers; this or `staffMemberId`' })
  @BooleanQuery()
  mine?: boolean;

  @ApiPropertyOptional({ format: 'uuid', description: 'A staff member of the Institution' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  staffMemberId?: string;
}

/** EXM-06 body (API design 9.8): the exam is the one in the path. */
export class CreateExamPaperDto {
  @ApiProperty({ format: 'uuid', description: 'An active section of the exam’s Institution' })
  @LowerCaseUuid()
  @IsUUID()
  sectionId!: string;

  @ApiProperty({ format: 'uuid', description: 'An active subject of the Society' })
  @LowerCaseUuid()
  @IsUUID()
  subjectId!: string;

  @ApiProperty({ format: 'date', example: '2026-08-10', description: 'A day the exam runs' })
  @IsCalendarDate()
  examDate!: string;

  @ApiProperty({ example: '09:00', description: '24-hour, `HH:MM`' })
  @IsClockTime()
  startTime!: string;

  @ApiProperty({ example: '11:00', description: 'After `startTime`' })
  @IsClockTime()
  endTime!: string;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 50, example: 'Room 12' })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  @NotBlank()
  roomName?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_MARKS_CEILING, default: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MARKS_CEILING)
  maxMarks?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_MARKS_CEILING,
    default: 35,
    description: 'At most `maxMarks`; 35, or `maxMarks` when that is lower, when left out',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MARKS_CEILING)
  passingMarks?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'A teacher of the Institution who teaches the subject',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  subjectTeacherStaffMemberId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Any active staff member of the Institution',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  invigilatorStaffMemberId?: string | null;
}

/**
 * EXM-07 body: an omitted field stays; the room, the teacher and the invigilator are cleared with `null`. The exam,
 * the section and the subject are not editable: to change one, deactivate the paper and add another.
 */
export class UpdateExamPaperDto extends VersionDto {
  @ApiPropertyOptional({ format: 'date', example: '2026-08-10' })
  @WhenPresent()
  @IsCalendarDate()
  examDate?: string;

  @ApiPropertyOptional({ example: '09:00' })
  @WhenPresent()
  @IsClockTime()
  startTime?: string;

  @ApiPropertyOptional({ example: '11:00' })
  @WhenPresent()
  @IsClockTime()
  endTime?: string;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 50 })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  @NotBlank()
  roomName?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_MARKS_CEILING })
  @WhenPresent()
  @IsInt()
  @Min(1)
  @Max(MAX_MARKS_CEILING)
  maxMarks?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_MARKS_CEILING })
  @WhenPresent()
  @IsInt()
  @Min(0)
  @Max(MAX_MARKS_CEILING)
  passingMarks?: number;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  subjectTeacherStaffMemberId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  invigilatorStaffMemberId?: string | null;
}
