import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { RequiredAddressDto } from '../../common/validation/address.dto.js';
import { PhoneDto } from '../../common/validation/phone.dto.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { TenantRootListQueryDto } from './tenant-root-list.query.js';

/** PRD 11.4: 1 CBSE, 2 ICSE, 3 State Board, 4 IB, 5 IGCSE, 6 Other. */
export const BOARD_CODES = [1, 2, 3, 4, 5, 6] as const;

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export class LocationDto {
  @ApiProperty({ minimum: -90, maximum: 90, example: 12.971599 })
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiProperty({ minimum: -180, maximum: 180, example: 77.594566 })
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  longitude!: number;
}

/** The optional profile fields, on create and on change. A body is JSON: no `@Type` on primitives. */
class InstitutionProfileDto {
  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  place?: string | null;

  @ApiPropertyOptional({ enum: BOARD_CODES, nullable: true })
  @IsOptional()
  @IsInt()
  @IsIn(BOARD_CODES)
  boardCode?: number | null;

  @ApiPropertyOptional({ maxLength: 50, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  affiliationNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '29ABCDE1234F1Z5' })
  @IsOptional()
  @IsString()
  @Matches(GSTIN)
  gstin?: string | null;

  @ApiPropertyOptional({ maxLength: 254, nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ type: PhoneDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PhoneDto)
  phone?: PhoneDto | null;

  @ApiPropertyOptional({ maxLength: 20, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  telephone?: string | null;

  @ApiPropertyOptional({ type: LocationDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto | null;
}

/** The address, where `null` is not a value: the first line is required (PRD 7.1). */
class AddressChangeDto {
  @ApiPropertyOptional({ type: RequiredAddressDto })
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @ValidateNested()
  @Type(() => RequiredAddressDto)
  address?: RequiredAddressDto;
}

/** INS-02 body. `societyId` is for Super Admin only; the service checks it, because it depends on the caller. */
export class CreateInstitutionDto extends InstitutionProfileDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Super Admin only: the Society to add to' })
  @IsOptional()
  @IsUUID()
  societyId?: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiProperty({ maxLength: 50, description: 'Unique in the Society, never changed' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;

  @ApiProperty({ type: RequiredAddressDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => RequiredAddressDto)
  address!: RequiredAddressDto;
}

/**
 * INS-04 body. An omitted field stays, `null` clears an optional one; `phone`,
 * `address` and `location` are replaced as a whole. `code`, `societyId`,
 * `status` and the pause are not fields here, so they answer FIELD_NOT_ALLOWED.
 */
export class UpdateInstitutionDto extends IntersectionType(
  VersionDto,
  InstitutionProfileDto,
  AddressChangeDto,
) {
  @ApiPropertyOptional({ maxLength: 255 })
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;
}

export const INSTITUTION_SORT_FIELDS = ['name', 'code', 'createdAt'] as const;

/** PLT-19 query. */
export class ListInstitutionsQueryDto extends TenantRootListQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  societyId?: string;
}
