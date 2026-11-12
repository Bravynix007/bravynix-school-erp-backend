import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { AddressDto } from '../../common/validation/address.dto.js';
import { IsCalendarDate } from '../../common/validation/calendar-date.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { NotBlank } from '../../common/validation/not-blank.js';
import { PHONE_NUMBER, PhoneDto } from '../../common/validation/phone.dto.js';
import { PlaceDto } from '../../common/validation/place.dto.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import { BLOOD_GROUPS, GENDERS } from './staff.dto.js';
import { StudentIdentityDto } from './student-identity.dto.js';

export const MAX_GUARDIANS = 5;
/** 1 Father, 2 Mother, 3 Guardian, 4 Grandparent, 5 Sibling, 6 Other (DDD 9.6). */
export const GUARDIAN_RELATIONS = [1, 2, 3, 4, 5, 6] as const;

/** A student's address: the lines and the place from the platform masters (API design 7.3). */
export class StudentAddressDto extends IntersectionType(AddressDto, PlaceDto) {}

/** The class and section a student starts in, and the roll number there (PRD 7.6). */
export class StudentEnrolmentDto {
  @ApiProperty({ format: 'uuid', description: 'An active year of the Institution' })
  @LowerCaseUuid()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  classId!: string;

  @ApiProperty({ format: 'uuid', description: 'An active section of the class' })
  @LowerCaseUuid()
  @IsUUID()
  sectionId!: string;

  @ApiProperty({ minLength: 1, maxLength: 20, example: '14', description: 'Unique in the section' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @NotBlank()
  rollNumber!: string;
}

/** One parent or guardian (PRD 7.6). An email links the person who signs in as Student / Parent. */
export class GuardianDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @NotBlank()
  firstName!: string;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string | null;

  @ApiProperty({
    enum: GUARDIAN_RELATIONS,
    description: '1 Father, 2 Mother, 3 Guardian, 4 Grandparent, 5 Sibling, 6 Other',
  })
  @IsInt()
  @IsIn(GUARDIAN_RELATIONS)
  relation!: number;

  @ApiProperty({ type: PhoneDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PhoneDto)
  phone!: PhoneDto;

  @ApiPropertyOptional({ nullable: true, description: '6 to 15 digits, in the country of `phone`' })
  @IsOptional()
  @Matches(PHONE_NUMBER)
  alternatePhone?: string | null;

  @ApiPropertyOptional({
    maxLength: 254,
    nullable: true,
    description:
      'The login: an email that belongs to a person links them, a new one makes a Pending account',
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

  @ApiProperty({ description: 'Exactly one guardian of a student is primary' })
  @IsBoolean()
  isPrimary!: boolean;

  @ApiProperty()
  @IsBoolean()
  isEmergencyContact!: boolean;
}

/**
 * The optional fields of a student's record, as STU-02 takes them and STU-04 changes them. A body is JSON: no `@Type`
 * on a primitive. Optional text is cleared with `null`.
 */
export class StudentDetailsDto {
  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string | null;

  @ApiPropertyOptional({ enum: GENDERS, nullable: true, description: '1 Male, 2 Female, 3 Other' })
  @IsOptional()
  @IsInt()
  @IsIn(GENDERS)
  gender?: number | null;

  @ApiPropertyOptional({ nullable: true, example: '2014-03-09', description: 'A past date' })
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
    description: 'A Ready file of purpose 3 in the Institution',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  photoFileId?: string | null;

  @ApiPropertyOptional({
    maxLength: 50,
    nullable: true,
    description: 'Admission ID, unique in the Institution',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @NotBlank()
  admissionNo?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-06-01',
    description: 'The day the placement starts; today when absent',
  })
  @IsOptional()
  @IsCalendarDate()
  admissionDate?: string | null;

  @ApiPropertyOptional({
    maxLength: 254,
    nullable: true,
    description: 'The student’s own email, not a login',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '6 to 15 digits, in the country of `mobile`',
  })
  @IsOptional()
  @Matches(PHONE_NUMBER)
  alternateNumber?: string | null;

  @ApiPropertyOptional({
    type: StudentAddressDto,
    nullable: true,
    description: 'On an edit, `null` clears the whole address and a missing field stays as it is',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => StudentAddressDto)
  address?: StudentAddressDto | null;
}

/** STU-02 body (API design 10.6). */
export class CreateStudentDto extends StudentDetailsDto {
  @ApiProperty({ format: 'uuid', description: 'The Institution the child joins' })
  @LowerCaseUuid()
  @IsUUID()
  institutionId!: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @NotBlank()
  firstName!: string;

  @ApiProperty({ type: PhoneDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PhoneDto)
  mobile!: PhoneDto;

  @ApiProperty({ type: StudentEnrolmentDto })
  @IsObject()
  @ValidateNested()
  @Type(() => StudentEnrolmentDto)
  enrolment!: StudentEnrolmentDto;

  @ApiProperty({ type: [GuardianDto], minItems: 1, maxItems: MAX_GUARDIANS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GUARDIANS)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => GuardianDto)
  guardians!: GuardianDto[];

  @ApiPropertyOptional({ type: StudentIdentityDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => StudentIdentityDto)
  identity?: StudentIdentityDto;
}

/** The fields of STU-04 that cannot be cleared: sent, they need a value. */
class StudentRequiredChangesDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @WhenPresent()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @NotBlank()
  firstName?: string;

  @ApiPropertyOptional({ type: PhoneDto })
  @WhenPresent()
  @IsObject()
  @ValidateNested()
  @Type(() => PhoneDto)
  mobile?: PhoneDto;
}

/**
 * STU-04 body: an omitted field stays and `null` clears one that may be empty. The guardians change on their own
 * endpoints, the class, section and roll number by STU-08, and the Institution never changes.
 */
export class UpdateStudentDto extends IntersectionType(
  VersionDto,
  IntersectionType(StudentRequiredChangesDto, StudentDetailsDto),
) {}

/** Why a student is deactivated: 1 Left the Institution, 2 Created by mistake, 3 Other (DDD 9.6). */
export const INACTIVE_REASONS = [1, 2, 3] as const;

/**
 * STU-05 query: the reason travels in the query, as a DELETE has no body that clients generated from the OpenAPI
 * document would send. Query values arrive as strings, so `reason` converts them.
 */
export class DeactivateStudentQueryDto {
  @ApiProperty({
    enum: INACTIVE_REASONS,
    description: '1 Left the Institution, 2 Created by mistake, 3 Other',
  })
  @Type(() => Number)
  @IsInt()
  @IsIn(INACTIVE_REASONS)
  reason!: number;
}

/**
 * STU-08 body: the section and the roll number the student has from `effectiveDate` (today when absent). Send the one
 * that changes, or both; the class and the year are those of the student's enrolment.
 */
export class MoveStudentDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'An open section of the same class' })
  @WhenPresent()
  @LowerCaseUuid()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 20,
    example: '14',
    description: 'Unique in the section',
  })
  @WhenPresent()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @NotBlank()
  rollNumber?: string;

  @ApiPropertyOptional({
    example: '2026-07-01',
    description:
      'First day in the new section: not before the current placement started, not after today',
  })
  @WhenPresent()
  @IsCalendarDate()
  effectiveDate?: string;
}

export const STUDENT_SORT_FIELDS = ['name', 'admissionNo', 'rollNumber', 'createdAt'] as const;
export type StudentSortField = (typeof STUDENT_SORT_FIELDS)[number];

/**
 * STU-01 query: search by name, Admission ID or roll number (`q`), and the class, section and year the student sits in.
 * A student is listed with the section they were last placed in, or in the year named. Query values arrive as strings,
 * so `status` converts them; a value that is not 0 or 1 fails validation as it stands.
 */
export class ListStudentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'One Institution the caller reaches' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The year of the placement shown and filtered on',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  classId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({
    enum: [0, 1],
    isArray: true,
    default: [1],
    description: 'Repeat for both; active only when absent',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : [value]).map((item: unknown) =>
      item === '' ? item : Number(item),
    ),
  )
  @IsArray()
  @IsIn([0, 1], { each: true })
  status?: number[];
}
