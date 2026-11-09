import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BooleanQuery } from '../../common/validation/boolean-query.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';

/*
 * PLT-31 and PLT-32 bodies, one pair per master (API design 10.4g). A body is
 * JSON, so no `@Type` on a primitive: "5" is INVALID_TYPE. The code, the ISO
 * code and the parent of an entry are set when it is added and never changed,
 * so the update bodies leave them out and a request that sends them is told
 * FIELD_NOT_ALLOWED.
 */

/** Any run of white space inside a name (a tab or no-break space too) is one space, so names that only look alike are `DUPLICATE`. */
const OneSpace = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/gu, ' ') : value,
  );

/** Upper case letters, digits and `_`, starting with a letter: `PRE_UNIVERSITY`. */
const CODE = /^[A-Z][A-Z0-9_]*$/;
/** A section code may start with a digit: `1`, `A`. */
const SECTION_CODE = /^[A-Z0-9][A-Z0-9_]*$/;

/** The position in the list the entry takes, counting hidden entries; the ones from there on move down one. */
class DisplayOrderDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Position in the list, hidden entries counted. On add, the entry is inserted there (default: last); on edit it moves there.',
  })
  @WhenPresent()
  @IsInt()
  @Min(1)
  @Max(32767)
  displayOrder?: number;
}

/** `status` on an edit: 0 hides the entry from pickers (PLT-33 does the same), 1 shows it again. */
function statusField() {
  return (target: object, key: string) => {
    ApiPropertyOptional({
      enum: [0, 1],
      description: '0 hides the entry from pickers, 1 shows it',
    })(target, key);
    WhenPresent()(target, key);
    IsInt()(target, key);
    IsIn([0, 1])(target, key);
  };
}

/** `displayOrder` on an edit: the position the entry moves to. */
function moveToField() {
  return (target: object, key: string) => {
    ApiPropertyOptional({
      minimum: 1,
      maximum: 32767,
      description: 'Moves the entry to this position, hidden entries counted',
    })(target, key);
    WhenPresent()(target, key);
    IsInt()(target, key);
    Min(1)(target, key);
    Max(32767)(target, key);
  };
}

function nameField(max: number) {
  return (target: object, key: string) => {
    ApiProperty({ minLength: 1, maxLength: max })(target, key);
    OneSpace()(target, key);
    IsString()(target, key);
    MinLength(1)(target, key);
    MaxLength(max)(target, key);
  };
}

function optionalNameField(max: number) {
  return (target: object, key: string) => {
    ApiPropertyOptional({ minLength: 1, maxLength: max })(target, key);
    WhenPresent()(target, key);
    OneSpace()(target, key);
    IsString()(target, key);
    MinLength(1)(target, key);
    MaxLength(max)(target, key);
  };
}

function codeField(max: number, pattern: RegExp) {
  return (target: object, key: string) => {
    ApiProperty({ maxLength: max, pattern: pattern.source, description: 'Never changed' })(
      target,
      key,
    );
    IsString()(target, key);
    Matches(pattern)(target, key);
    MaxLength(max)(target, key);
  };
}

// ----- countries

export class CreateCountryDto {
  @nameField(100)
  name!: string;

  @ApiProperty({
    pattern: '^[A-Z]{2}$',
    example: 'IN',
    description: 'ISO 3166-1 alpha-2, never changed',
  })
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  iso2!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '91',
    description: 'Dialling code without the plus',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{1,5}$/)
  phoneCode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'INR' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string | null;
}

export class UpdateCountryDto extends VersionDto {
  @optionalNameField(100)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{1,5}$/)
  phoneCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string | null;

  @statusField()
  status?: 0 | 1;
}

// ----- states and cities

export class CreateStateDto {
  @ApiProperty({ format: 'uuid', description: 'The country; never changed' })
  @LowerCaseUuid()
  @IsUUID()
  countryId!: string;

  @nameField(100)
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'KA', pattern: '^[A-Z0-9]{1,5}$' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{1,5}$/)
  iso2?: string | null;
}

export class CreateCityDto {
  @ApiProperty({ format: 'uuid', description: 'The state; never changed' })
  @LowerCaseUuid()
  @IsUUID()
  stateId!: string;

  @nameField(120)
  name!: string;
}

/** The only fields of a state or a city that change: its name, and whether it is shown. */
export class UpdateStateDto extends VersionDto {
  @optionalNameField(100)
  name?: string;

  @statusField()
  status?: 0 | 1;
}

export class UpdateCityDto extends VersionDto {
  @optionalNameField(120)
  name?: string;

  @statusField()
  status?: 0 | 1;
}

// ----- the ordered lists

export class CreateClassCategoryDto extends DisplayOrderDto {
  @codeField(30, CODE)
  code!: string;

  @nameField(60)
  name!: string;
}

export class UpdateClassCategoryDto extends VersionDto {
  @optionalNameField(60)
  name?: string;

  @moveToField()
  displayOrder?: number;

  @statusField()
  status?: 0 | 1;
}

export class CreatePredefinedClassDto extends DisplayOrderDto {
  @ApiProperty({ format: 'uuid', description: 'The class category; never changed' })
  @LowerCaseUuid()
  @IsUUID()
  classCategoryId!: string;

  @codeField(20, CODE)
  code!: string;

  @nameField(50)
  name!: string;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 99, example: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  numericValue?: number | null;
}

export class UpdatePredefinedClassDto extends VersionDto {
  @optionalNameField(50)
  name?: string;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 99 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  numericValue?: number | null;

  @moveToField()
  displayOrder?: number;

  @statusField()
  status?: 0 | 1;
}

export class CreatePredefinedSectionDto extends DisplayOrderDto {
  @codeField(10, SECTION_CODE)
  code!: string;

  @nameField(10)
  name!: string;
}

export class UpdatePredefinedSectionDto extends VersionDto {
  @optionalNameField(10)
  name?: string;

  @moveToField()
  displayOrder?: number;

  @statusField()
  status?: 0 | 1;
}

export class CreateDesignationDto extends DisplayOrderDto {
  @codeField(30, CODE)
  code!: string;

  @nameField(60)
  name!: string;
}

export class UpdateDesignationDto extends VersionDto {
  @optionalNameField(60)
  name?: string;

  @moveToField()
  displayOrder?: number;

  @statusField()
  status?: 0 | 1;
}

/**
 * MST-01 query. Query values arrive as strings, so the boolean converts; a value
 * that is neither `true` nor `false` fails validation as it stands. Which
 * filter a master takes is checked against its catalogue entry.
 */
export class MasterQueryDto {
  @ApiPropertyOptional({
    description: 'Super Admin only: also list the entries hidden from pickers',
  })
  @BooleanQuery()
  includeHidden?: boolean;

  @ApiPropertyOptional({ format: 'uuid', description: 'States of this country' })
  @IsOptional()
  @IsUUID()
  countryId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Cities of this state (required for cities)',
  })
  @IsOptional()
  @IsUUID()
  stateId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Predefined classes of this class category' })
  @IsOptional()
  @IsUUID()
  classCategoryId?: string;
}
