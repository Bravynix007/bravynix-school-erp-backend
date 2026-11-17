import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { IsClockTime } from '../../common/validation/clock-time.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { NotBlank } from '../../common/validation/not-blank.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import { MAX_PERIOD_NO } from './time-slot.rules.js';

/**
 * TTS-01 query: the Institution (everyone but a parent), optionally one of its academic years (the current year
 * when left out), or a parent's own child, whose Institution it is.
 */
export class ListTimeSlotsQueryDto {
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

/** TTS-02 body (API design 9.4). */
export class CreateTimeSlotDto {
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

  @ApiProperty({ minimum: 1, maximum: MAX_PERIOD_NO, example: 3 })
  @IsInt()
  @Min(1)
  @Max(MAX_PERIOD_NO)
  periodNo!: number;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 100, example: 'Period 3' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @NotBlank()
  label?: string | null;

  @ApiProperty({ example: '09:40', description: '24-hour, `HH:MM`' })
  @IsClockTime()
  startTime!: string;

  @ApiProperty({ example: '10:20', description: 'After `startTime`' })
  @IsClockTime()
  endTime!: string;

  @ApiPropertyOptional({ description: 'A break, such as lunch, takes only a break entry' })
  @IsOptional()
  @IsBoolean()
  isBreak?: boolean;
}

/**
 * TTS-03 body: an omitted field stays; `label` is cleared with `null`. The number and whether it is a break are not
 * editable: to change them, deactivate the period and add another.
 */
export class UpdateTimeSlotDto extends VersionDto {
  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @NotBlank()
  label?: string | null;

  @ApiPropertyOptional({ example: '09:40' })
  @WhenPresent()
  @IsClockTime()
  startTime?: string;

  @ApiPropertyOptional({ example: '10:20' })
  @WhenPresent()
  @IsClockTime()
  endTime?: string;
}
