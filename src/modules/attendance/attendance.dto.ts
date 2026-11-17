import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsCalendarDate } from '../../common/validation/calendar-date.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { EXCEPTION_STATUSES } from './attendance.rules.js';

/** The most students one section can have to mark: the roster the screen loads (API design 10.10). */
const MAX_ROSTER = 1000;

/** ATT-01 query: one roster for a section and day (API design 10.10). */
export class RosterQueryDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  sectionId!: string;

  @ApiProperty({ format: 'date', example: '2026-10-23' })
  @IsCalendarDate()
  date!: string;
}

/** ATT-03 query: the sessions of a section, or of every section of an Institution, on a day. */
export class ListSessionsQueryDto {
  @ApiProperty({ format: 'date', example: '2026-10-23' })
  @IsCalendarDate()
  date!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'One section; the Institution is then its own',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Every section of this Institution; required without `sectionId`',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  institutionId?: string;
}

/** One student who is not Present. Present is never sent: a student left out was Present (DDD M3). */
export class AttendanceExceptionDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  studentEnrolmentId!: string;

  @ApiProperty({ enum: EXCEPTION_STATUSES, description: '2 Absent, 3 Late, 4 Half day, 5 Leave' })
  @IsIn(EXCEPTION_STATUSES)
  attendanceStatus!: number;
}

/** ATT-02 body (API design 10.11). */
export class SubmitAttendanceDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  sectionId!: string;

  @ApiProperty({ format: 'date', example: '2026-10-23' })
  @IsCalendarDate()
  attendanceDate!: string;

  @ApiProperty({
    minimum: 0,
    maximum: MAX_ROSTER,
    description: 'The number of students the app showed',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_ROSTER)
  rosterCount!: number;

  @ApiProperty({ type: [AttendanceExceptionDto], maxItems: MAX_ROSTER })
  @IsArray()
  @ArrayMaxSize(MAX_ROSTER)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => AttendanceExceptionDto)
  exceptions!: AttendanceExceptionDto[];
}
