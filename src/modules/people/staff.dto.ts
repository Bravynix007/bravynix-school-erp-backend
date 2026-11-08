import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AddressDto } from '../../common/validation/address.dto.js';
import { IsCalendarDate } from '../../common/validation/calendar-date.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { PhoneDto } from '../../common/validation/phone.dto.js';
import { PlaceDto } from '../../common/validation/place.dto.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';

export const MAX_EDUCATIONS = 20;
export const MAX_EMERGENCY_CONTACTS = 10;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
/** 1 Male, 2 Female, 3 Other (DDD 9.5). */
export const GENDERS = [1, 2, 3] as const;
/** 1 Full time, 2 Part time, 3 Visiting, 4 Contract (DDD 9.5). */
export const EMPLOYMENT_TYPES = [1, 2, 3, 4] as const;

const PHONE_NUMBER = /^\d{6,15}$/;

/** A person's address: the lines and the place from the platform masters (API design 7.3). Each part clears with `null`. */
export class StaffAddressDto extends IntersectionType(AddressDto, PlaceDto) {}

/** One education line (PRD 7.5). */
export class EducationDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'B.Ed' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  degree!: string;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  qualification?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  specialization?: string | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true, description: 'Where they studied' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  institutionName?: string | null;

  @ApiPropertyOptional({ minimum: 1900, maximum: 2200, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2200)
  yearOfPassing?: number | null;
}

/** One emergency or guardian contact (PRD 7.5). */
export class EmergencyContactDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  contactName!: string;

  @ApiPropertyOptional({ maxLength: 50, nullable: true, example: 'Spouse' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  relation?: string | null;

  @ApiProperty({ type: PhoneDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PhoneDto)
  phone!: PhoneDto;

  @ApiPropertyOptional({ nullable: true, description: '6 to 15 digits, in the country of `phone`' })
  @IsOptional()
  @Matches(PHONE_NUMBER)
  alternateNumber?: string | null;

  @ApiProperty({ description: 'At most one contact is primary' })
  @IsBoolean()
  isPrimary!: boolean;
}

/**
 * The fields a staff record can hold besides the ones that decide who and where (API design 9.5). A body is JSON:
 * no `@Type` on a primitive. Optional text is cleared with `null`, never `""`.
 */
export class StaffDetailsDto {
  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string | null;

  @ApiPropertyOptional({
    maxLength: 50,
    nullable: true,
    description: 'Employee ID, unique in the Institution',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  employeeCode?: string | null;

  @ApiPropertyOptional({ enum: GENDERS, nullable: true, description: '1 Male, 2 Female, 3 Other' })
  @IsOptional()
  @IsInt()
  @IsIn(GENDERS)
  gender?: number | null;

  @ApiPropertyOptional({ nullable: true, example: '1990-04-12', description: 'A past date' })
  @IsOptional()
  @IsCalendarDate()
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ enum: BLOOD_GROUPS, nullable: true })
  @IsOptional()
  @IsString()
  @IsIn(BLOOD_GROUPS)
  bloodGroup?: string | null;

  @ApiPropertyOptional({ maxLength: 50, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  nationality?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'A Ready file of purpose 4 in the home Institution',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  photoFileId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'A designation of the platform masters',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  designationId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '6 to 15 digits, in the country of `mobile`',
  })
  @IsOptional()
  @Matches(PHONE_NUMBER)
  alternateNumber?: string | null;

  @ApiPropertyOptional({ type: StaffAddressDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => StaffAddressDto)
  address?: StaffAddressDto;

  @ApiPropertyOptional({ nullable: true, example: '2024-06-03' })
  @IsOptional()
  @IsCalendarDate()
  joiningDate?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-03-31',
    description: 'On or after the joining date',
  })
  @IsOptional()
  @IsCalendarDate()
  resignationDate?: string | null;

  @ApiPropertyOptional({
    enum: EMPLOYMENT_TYPES,
    nullable: true,
    description: '1 Full time, 2 Part time, 3 Visiting, 4 Contract',
  })
  @IsOptional()
  @IsInt()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: number | null;

  @ApiPropertyOptional({ type: [EducationDto], maxItems: MAX_EDUCATIONS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EDUCATIONS)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => EducationDto)
  educations?: EducationDto[];

  @ApiPropertyOptional({ type: [EmergencyContactDto], maxItems: MAX_EMERGENCY_CONTACTS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EMERGENCY_CONTACTS)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => EmergencyContactDto)
  emergencyContacts?: EmergencyContactDto[];
}

/** STF-02 body (API design 9.5). The email is the login: it names a person who exists or makes a Pending one. */
export class CreateStaffDto extends StaffDetailsDto {
  @ApiProperty({ format: 'uuid', description: 'The home Institution' })
  @LowerCaseUuid()
  @IsUUID()
  homeInstitutionId!: string;

  @ApiProperty({ maxLength: 254, example: 'asha.rao@example.com' })
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ format: 'uuid', description: 'Category or department, from the platform masters' })
  @LowerCaseUuid()
  @IsUUID()
  classCategoryId!: string;

  @ApiProperty({ type: PhoneDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PhoneDto)
  mobile!: PhoneDto;
}

/** The fields of STF-04 that cannot be cleared: sent, they need a value. */
class StaffRequiredChangesDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @WhenPresent()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @WhenPresent()
  @LowerCaseUuid()
  @IsUUID()
  classCategoryId?: string;

  @ApiPropertyOptional({ type: PhoneDto })
  @WhenPresent()
  @IsObject()
  @ValidateNested()
  @Type(() => PhoneDto)
  mobile?: PhoneDto;
}

/**
 * STF-04 body: an omitted field stays, `null` clears one that may be empty, and the two lists are replaced whole.
 * The email is changed by STF-13 and the home Institution does not change here.
 */
export class UpdateStaffDto extends IntersectionType(
  VersionDto,
  IntersectionType(StaffRequiredChangesDto, StaffDetailsDto),
) {}
