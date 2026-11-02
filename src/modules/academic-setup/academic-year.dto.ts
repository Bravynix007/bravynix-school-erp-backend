import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsString, IsUUID, Length, Matches } from 'class-validator';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const IsCalendarDate = () =>
  applyDecorators(IsString(), Matches(DATE_ONLY), IsISO8601({ strict: true }));

/** AY-01 query: the Institution whose years are listed (API design 6.5). */
export class ListAcademicYearsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  institutionId!: string;
}

/** AY-02 body (API design 10.4h). */
export class CreateAcademicYearDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  institutionId!: string;

  @ApiProperty({ minLength: 1, maxLength: 20, example: '2026-2027' })
  @IsString()
  @Length(1, 20)
  name!: string;

  @ApiProperty({ example: '2026-06-01' })
  @IsCalendarDate()
  startDate!: string;

  @ApiProperty({ example: '2027-03-31', description: 'After the start date' })
  @IsCalendarDate()
  endDate!: string;
}

/** AY-03 body: an omitted field stays. Which year is current is not a field here (AY-04). */
export class UpdateAcademicYearDto extends VersionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 20 })
  @WhenPresent()
  @IsString()
  @Length(1, 20)
  name?: string;

  @ApiPropertyOptional({ example: '2026-06-01' })
  @WhenPresent()
  @IsCalendarDate()
  startDate?: string;

  @ApiPropertyOptional({ example: '2027-03-31' })
  @WhenPresent()
  @IsCalendarDate()
  endDate?: string;
}
