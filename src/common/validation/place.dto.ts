import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { LowerCaseUuid } from './lower-case-uuid.js';

/**
 * The place of an address from the platform masters (API design 7.3): each part is optional, but a state needs its
 * country and a city its state, which the master check enforces. Clears with `null`.
 */
export class PlaceDto {
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  countryId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'A state of the country' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  stateId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'A city of the state' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  cityId?: string | null;
}
