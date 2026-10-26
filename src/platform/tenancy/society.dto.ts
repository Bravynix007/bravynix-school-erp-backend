import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { NewPersonDto } from '../identity/index.js';
import { AddressDto } from '../../common/validation/address.dto.js';
import { PhoneDto } from '../../common/validation/phone.dto.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { TenantRootListQueryDto } from './tenant-root-list.query.js';

const WEBSITE = /^https?:\/\/\S+$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The profile fields a Society has, on create and on change. A body is JSON: no `@Type` on primitives. */
class SocietyProfileDto {
  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ maxLength: 254, nullable: true, example: 'office@sunrise.example.org' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ type: PhoneDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PhoneDto)
  phone?: PhoneDto | null;

  @ApiPropertyOptional({ maxLength: 255, nullable: true, example: 'https://sunrise.example.org' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(WEBSITE)
  website?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '1998-06-01' })
  @IsOptional()
  @Matches(DATE_ONLY)
  @IsISO8601({ strict: true })
  foundedDate?: string | null;

  @ApiPropertyOptional({ type: AddressDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto | null;
}

/** PLT-03 body. */
export class CreateSocietyDto extends SocietyProfileDto {
  @ApiProperty({ maxLength: 255, example: 'Sunrise Education Trust' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiProperty({ maxLength: 50, example: 'SUNRISE', description: 'Unique, never changed' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;

  @ApiPropertyOptional({
    type: [NewPersonDto],
    description: 'The first one to three Owners, by email',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => NewPersonDto)
  owners?: NewPersonDto[];
}

/**
 * PLT-05 body. An omitted field stays, `null` clears an optional one. `phone`
 * and `address` are replaced as a whole. `code`, `status` and the pause are
 * not fields here, so the global pipe answers FIELD_NOT_ALLOWED.
 */
export class UpdateSocietyDto extends IntersectionType(VersionDto, SocietyProfileDto) {
  @ApiPropertyOptional({ maxLength: 255 })
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;
}

export const SOCIETY_SORT_FIELDS = ['name', 'code', 'createdAt'] as const;

/** PLT-02 query. */
export class ListSocietiesQueryDto extends TenantRootListQueryDto {}
