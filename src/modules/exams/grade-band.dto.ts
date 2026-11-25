import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { NotBlank } from '../../common/validation/not-blank.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import { MAX_GRADE_POINT } from './grade-band.rules.js';

/** A percentage or a grade point: a finite number with two decimals at most (DDD 9.7, numeric(5,2) and (4,2)). */
const TwoDecimals = () => IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false });

/** GRD-01 query: the Institution (everyone but a parent), or a parent's own child, whose Institution it is. */
export class ListGradeBandsQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Required for everyone but a parent' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A parent’s own child, whose Institution’s bands are read (parents only)',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  studentId?: string;
}

/** GRD-02 body (API design 9.4). */
export class CreateGradeBandDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  institutionId!: string;

  @ApiProperty({ minLength: 1, maxLength: 20, example: 'A1' })
  @IsString()
  @Length(1, 20)
  @NotBlank()
  name!: string;

  @ApiProperty({ minimum: 0, maximum: 100, example: 91, description: 'Belongs to the band' })
  @TwoDecimals()
  @Min(0)
  @Max(100)
  minPercentage!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 100,
    example: 100,
    description: 'Belongs to the band; not below `minPercentage`',
  })
  @TwoDecimals()
  @Min(0)
  @Max(100)
  maxPercentage!: number;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: MAX_GRADE_POINT, example: 10 })
  @IsOptional()
  @TwoDecimals()
  @Min(0)
  @Max(MAX_GRADE_POINT)
  gradePoint?: number | null;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 100, example: 'Outstanding' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @NotBlank()
  description?: string | null;
}

/** GRD-03 body: an omitted field stays; `gradePoint` and `description` are cleared with `null`. */
export class UpdateGradeBandDto extends VersionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 20 })
  @WhenPresent()
  @IsString()
  @Length(1, 20)
  @NotBlank()
  name?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @WhenPresent()
  @TwoDecimals()
  @Min(0)
  @Max(100)
  minPercentage?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @WhenPresent()
  @TwoDecimals()
  @Min(0)
  @Max(100)
  maxPercentage?: number;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: MAX_GRADE_POINT })
  @IsOptional()
  @TwoDecimals()
  @Min(0)
  @Max(MAX_GRADE_POINT)
  gradePoint?: number | null;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @NotBlank()
  description?: string | null;
}
