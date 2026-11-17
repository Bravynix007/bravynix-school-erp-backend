import { applyDecorators } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';

/** A time of day as the API writes it: `HH:MM`, 24-hour (API design 7.3). */
const TIME_ONLY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real time of day in that form: `24:00` and `9:40` are 400. Put `@IsOptional()` or `@WhenPresent()` in front where the field may be omitted. */
export const IsClockTime = () => applyDecorators(IsString(), Matches(TIME_ONLY));
