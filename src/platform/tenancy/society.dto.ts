import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { PhoneDto } from '../../common/validation/phone.dto.js';
import { VersionDto } from '../../common/validation/version.dto.js';

/** PLT-03 and PLT-05 address (API design 7.3); the master-list ids join when the masters exist. */
export class AddressDto {
  @ApiPropertyOptional({ maxLength: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  line1?: string | null;

  @ApiPropertyOptional({ maxLength: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  line2?: string | null;

  @ApiPropertyOptional({ maxLength: 10, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  pincode?: string | null;
}

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

/** PLT-07 body: why access is paused, shown to the Society's people. */
export class PauseSocietyDto extends VersionDto {
  @ApiProperty({ minLength: 1, maxLength: 500, example: 'Annual fee unpaid' })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export const SOCIETY_SORT_FIELDS = ['name', 'code', 'createdAt'] as const;

const toList = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value) ? value : value === undefined ? undefined : [value];

/** PLT-02 query. Query values arrive as strings, so these do convert them. */
export class ListSocietiesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: [0, 1], isArray: true, description: 'Repeat for both' })
  @IsOptional()
  @Transform((params) => {
    const list = toList(params);
    return Array.isArray(list) ? list.map((item) => (item === '' ? item : Number(item))) : list;
  })
  @IsArray()
  @IsIn([0, 1], { each: true })
  status?: number[];

  @ApiPropertyOptional({ description: 'Only paused, or only not paused' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  paused?: boolean;
}
