import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { BooleanQuery } from '../../common/validation/boolean-query.js';
import { IsCalendarDate } from '../../common/validation/calendar-date.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { NotBlank } from '../../common/validation/not-blank.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import {
  AUDIENCES,
  EVENT_SCOPES,
  HOLIDAY_TYPES,
  MAX_HOLIDAY_CLASSES,
  PRESET_IMAGES,
} from './event.rules.js';

/** EVT-01 query: a span of dates, or an academic year of an Institution; optionally holidays only. */
export class ListEventsQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'First day; with `to`, or use `academicYearId`',
  })
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Last day, at most 366 days after `from`' })
  @IsOptional()
  @IsCalendarDate()
  to?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The dates of this academic year of `institutionId`, instead of `from` and `to`',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only the Society-wide events and this Institution’s',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({ description: 'Only holidays' })
  @BooleanQuery()
  holidays?: boolean;
}

/** The fields EVT-02 takes and EVT-04 may change (API design 10.26). */
class EventFieldsDto {
  @ApiProperty({ minLength: 1, maxLength: 150, example: 'Annual Day' })
  @IsString()
  @Length(1, 150)
  @NotBlank()
  title!: string;

  @ApiProperty({ format: 'date', example: '2026-12-22' })
  @IsCalendarDate()
  startDate!: string;

  @ApiProperty({ format: 'date', example: '2026-12-24', description: 'On or after `startDate`' })
  @IsCalendarDate()
  endDate!: string;

  @ApiProperty({ minLength: 1, maxLength: 50, example: '3 Days Holiday' })
  @IsString()
  @Length(1, 50)
  @NotBlank()
  durationLabel!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  venue?: string | null;

  @ApiPropertyOptional({
    enum: AUDIENCES,
    description: '1 Everyone (default), 2 Students and parents, 3 Staff',
  })
  @IsOptional()
  @IsInt()
  @IsIn(AUDIENCES)
  audience?: number;

  @ApiPropertyOptional({
    nullable: true,
    enum: PRESET_IMAGES,
    description: 'A picture the app ships',
  })
  @IsOptional()
  @IsString()
  @IsIn(PRESET_IMAGES)
  presetImageCode?: string | null;

  @ApiPropertyOptional({ description: 'A holiday needs `holidayType` and who it is for' })
  @IsOptional()
  @IsBoolean()
  isHoliday?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    enum: HOLIDAY_TYPES,
    description: '1 Public holiday, 2 Vacation, 3 Event holiday, 4 Optional',
  })
  @IsOptional()
  @IsInt()
  @IsIn(HOLIDAY_TYPES)
  holidayType?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  holidayForStudents?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  holidayForStaff?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'The predefined classes the holiday is for; empty is every class',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_HOLIDAY_CLASSES)
  @LowerCaseUuid()
  @IsUUID('all', { each: true })
  holidayPredefinedClassIds?: string[];
}

/** EVT-02 body. */
export class CreateEventDto extends EventFieldsDto {
  @ApiProperty({ enum: EVENT_SCOPES, description: '1 Society (Owner only), 2 Institution' })
  @IsInt()
  @IsIn(EVENT_SCOPES)
  scope!: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required exactly when `scope` is 2' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  institutionId?: string;
}

/**
 * EVT-04 body: every field of EVT-02 but the scope, each optional. A field left out stays, `description`, `venue`,
 * `presetImageCode` and `holidayType` are cleared with `null`.
 */
export class UpdateEventDto extends VersionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 150 })
  @WhenPresent()
  @IsString()
  @Length(1, 150)
  @NotBlank()
  title?: string;

  @ApiPropertyOptional({ format: 'date' })
  @WhenPresent()
  @IsCalendarDate()
  startDate?: string;

  @ApiPropertyOptional({ format: 'date' })
  @WhenPresent()
  @IsCalendarDate()
  endDate?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 50 })
  @WhenPresent()
  @IsString()
  @Length(1, 50)
  @NotBlank()
  durationLabel?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  venue?: string | null;

  @ApiPropertyOptional({ enum: AUDIENCES })
  @WhenPresent()
  @IsInt()
  @IsIn(AUDIENCES)
  audience?: number;

  @ApiPropertyOptional({ nullable: true, enum: PRESET_IMAGES })
  @IsOptional()
  @IsString()
  @IsIn(PRESET_IMAGES)
  presetImageCode?: string | null;

  @ApiPropertyOptional()
  @WhenPresent()
  @IsBoolean()
  isHoliday?: boolean;

  @ApiPropertyOptional({ nullable: true, enum: HOLIDAY_TYPES })
  @IsOptional()
  @IsInt()
  @IsIn(HOLIDAY_TYPES)
  holidayType?: number | null;

  @ApiPropertyOptional()
  @WhenPresent()
  @IsBoolean()
  holidayForStudents?: boolean;

  @ApiPropertyOptional()
  @WhenPresent()
  @IsBoolean()
  holidayForStaff?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Replaces the set; empty is every class' })
  @WhenPresent()
  @IsArray()
  @ArrayMaxSize(MAX_HOLIDAY_CLASSES)
  @LowerCaseUuid()
  @IsUUID('all', { each: true })
  holidayPredefinedClassIds?: string[];
}

/** EVT-06 body: the new scope, with the Institution when it is 2. */
export class ChangeEventScopeDto extends VersionDto {
  @ApiProperty({ enum: EVENT_SCOPES })
  @IsInt()
  @IsIn(EVENT_SCOPES)
  scope!: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required exactly when `scope` is 2' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  institutionId?: string;
}
