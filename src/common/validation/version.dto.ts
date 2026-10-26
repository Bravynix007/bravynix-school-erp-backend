import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

/**
 * The `version` a client read, sent back with every change and action so a
 * stale screen gets 409 `VERSION_CONFLICT` (API design 14.3). No `@Type`: a
 * body is JSON, so "3" must fail as INVALID_TYPE.
 */
export class VersionDto {
  @ApiProperty({ minimum: 1, example: 3 })
  @IsInt()
  @Min(1)
  version!: number;
}
