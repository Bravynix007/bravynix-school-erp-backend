import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, Length, Matches } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Money as the API writes it: a decimal string with exactly two decimals (API design 7.5); the column holds eight whole digits. */
const RATE = /^\d{1,8}\.\d{2}$/;

/** PLT-23 body: the rate per student in rupees, and the first day it applies. */
export class SetPriceRateDto {
  @ApiProperty({ example: '50.00', pattern: RATE.source })
  @IsString()
  @Matches(RATE)
  ratePerStudentAmount!: string;

  @ApiProperty({ example: '2026-04-01', description: 'May be in the past or the future' })
  @IsString()
  @Matches(DATE_ONLY)
  @IsISO8601({ strict: true })
  effectiveFromDate!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, example: 'Agreed for 2026-27' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string | null;
}
