import { ApiProperty } from '@nestjs/swagger';
import { IsYearMonth } from '../../common/validation/year-month.js';

/** ATT-07 query: the month to show, written `YYYY-MM` (API design 10.13). */
export class CalendarQueryDto {
  @ApiProperty({ example: '2026-10', description: 'A month inside an academic year of the school' })
  @IsYearMonth()
  month!: string;
}
