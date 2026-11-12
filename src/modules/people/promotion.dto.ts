import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { NotBlank } from '../../common/validation/not-blank.js';
import { WhenPresent } from '../../common/validation/when-present.js';

/**
 * Where the students go (API design 10.7): the next year, class and section, all three or all three `null`. With none
 * the students complete the final class: their enrolment ends as Completed and they get no new placement.
 */
export class PromotionTargetDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'An active academic year of the Institution that begins after the source year',
  })
  @ValidateIf((_dto, value: unknown) => value !== null)
  @LowerCaseUuid()
  @IsUUID()
  toAcademicYearId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, description: 'The same class repeats it' })
  @ValidateIf((_dto, value: unknown) => value !== null)
  @LowerCaseUuid()
  @IsUUID()
  toClassId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, description: 'An open section of the new class' })
  @ValidateIf((_dto, value: unknown) => value !== null)
  @LowerCaseUuid()
  @IsUUID()
  toSectionId!: string | null;
}

/** STU-09 body: the target, and optionally the roll number the student takes (the old one when absent). */
export class PromoteStudentDto extends PromotionTargetDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 20, example: '14' })
  @WhenPresent()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @NotBlank()
  rollNumber?: string;
}

/** PRM-01 body: the class (and section) to promote from, the target, and which students and roll numbers. */
export class PromoteClassDto extends PromotionTargetDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  institutionId!: string;

  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  fromAcademicYearId!: string;

  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  fromClassId!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: '`null` is every section of the class',
  })
  @ValidateIf((_dto, value: unknown) => value !== null)
  @LowerCaseUuid()
  @IsUUID()
  fromSectionId!: string | null;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'A subset of the students placed there; all of them when absent. At most 500',
  })
  @WhenPresent()
  @IsArray()
  @ArrayUnique()
  @LowerCaseUuid()
  @IsUUID('all', { each: true })
  studentIds?: string[];

  @ApiPropertyOptional({
    default: true,
    description: 'False numbers the students again from the highest number the new section holds',
  })
  @WhenPresent()
  @IsBoolean()
  keepRollNumbers?: boolean;
}
