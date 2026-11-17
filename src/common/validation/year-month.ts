import { applyDecorators } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';

/** A month as the API writes it: `YYYY-MM`, the month 01 to 12 (API design 7.4). */
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A real month in that form: `2026-13` and `2026-5` are 400. */
export const IsYearMonth = () => applyDecorators(IsString(), Matches(YEAR_MONTH));
