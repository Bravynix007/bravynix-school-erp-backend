import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * An optional boolean in the query string, where every value arrives as text: `true` and `false` become booleans,
 * and anything else is left for `IsBoolean` to refuse (400 `INVALID_TYPE`). Only for query DTOs; a body already has
 * its types (API design 12.1).
 */
export const BooleanQuery = () =>
  applyDecorators(
    IsOptional(),
    Transform(({ value }: { value: unknown }) =>
      value === 'true' ? true : value === 'false' ? false : value,
    ),
    IsBoolean(),
  );
