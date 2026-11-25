import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { IsCalendarDate } from '../../common/validation/calendar-date.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { NotBlank } from '../../common/validation/not-blank.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import { EXAM_TYPES } from './exam.rules.js';

/**
 * EXM-01 query: the Institution (everyone but a parent), optionally one of its academic years (the current year when
 * left out), or a parent's own child, whose Institution it is.
 */
export class ListExamsQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Required for everyone but a parent' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'An academic year of `institutionId`; the current year when left out',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A parent’s own child, whose Institution’s current year is read (parents only)',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  studentId?: string;
}

/** EXM-02 body (API design 9.8). */
export class CreateExamDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  institutionId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'An active academic year of the Institution; its current year when left out',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  academicYearId?: string;

  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Unit Test 1' })
  @IsString()
  @Length(1, 100)
  @NotBlank()
  name!: string;

  @ApiProperty({
    enum: EXAM_TYPES,
    example: 1,
    description: '1 Unit test, 2 Mid term, 3 Final, 4 Quarterly, 5 Half yearly, 6 Annual',
  })
  @IsInt()
  @IsIn(EXAM_TYPES)
  examType!: number;

  @ApiProperty({ format: 'date', example: '2026-08-10', description: 'Inside the academic year' })
  @IsCalendarDate()
  startDate!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-08-14',
    description: 'On or after `startDate`, inside the academic year',
  })
  @IsCalendarDate()
  endDate!: string;
}

/**
 * EXM-03 body: an omitted field stays. The Institution and the year are not editable: to change them, deactivate the
 * exam and add another.
 */
export class UpdateExamDto extends VersionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @WhenPresent()
  @IsString()
  @Length(1, 100)
  @NotBlank()
  name?: string;

  @ApiPropertyOptional({ enum: EXAM_TYPES })
  @WhenPresent()
  @IsInt()
  @IsIn(EXAM_TYPES)
  examType?: number;

  @ApiPropertyOptional({ format: 'date', example: '2026-08-10' })
  @WhenPresent()
  @IsCalendarDate()
  startDate?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-08-14' })
  @WhenPresent()
  @IsCalendarDate()
  endDate?: string;
}
