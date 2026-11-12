import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { NotBlank } from '../../common/validation/not-blank.js';
import { PHONE_NUMBER, PhoneDto } from '../../common/validation/phone.dto.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import { GUARDIAN_RELATIONS } from './student.dto.js';

/** The fields of GDN-03 that cannot be cleared: sent, they need a value. */
class GuardianRequiredChangesDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @WhenPresent()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @NotBlank()
  firstName?: string;

  @ApiPropertyOptional({ enum: GUARDIAN_RELATIONS })
  @WhenPresent()
  @IsInt()
  @IsIn(GUARDIAN_RELATIONS)
  relation?: number;

  @ApiPropertyOptional({ type: PhoneDto })
  @WhenPresent()
  @IsObject()
  @ValidateNested()
  @Type(() => PhoneDto)
  phone?: PhoneDto;

  @ApiPropertyOptional({
    description:
      '`true` makes this guardian the primary and the previous primary an ordinary guardian; `false` is refused for the primary',
  })
  @WhenPresent()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @WhenPresent()
  @IsBoolean()
  isEmergencyContact?: boolean;
}

/** The fields of GDN-03 that `null` clears. */
class GuardianOptionalChangesDto {
  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string | null;

  @ApiPropertyOptional({ nullable: true, description: '6 to 15 digits, in the country of `phone`' })
  @IsOptional()
  @Matches(PHONE_NUMBER)
  alternatePhone?: string | null;

  @ApiPropertyOptional({
    maxLength: 254,
    nullable: true,
    description:
      'The login. An email that belongs to no person changes the person’s own email when this link is all they hold, else it makes a new person; an email that belongs to a person moves the link to them; `null` takes the login away',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  occupation?: string | null;
}

/** GDN-03 body: an omitted field stays and `null` clears one that may be empty. A body is JSON: no `@Type` on a primitive. */
export class UpdateGuardianDto extends IntersectionType(
  VersionDto,
  IntersectionType(GuardianRequiredChangesDto, GuardianOptionalChangesDto),
) {}
