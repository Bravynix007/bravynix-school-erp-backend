import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';

/** The largest capacity a section can state: the column is a smallint. */
export const MAX_CAPACITY = 32_767;

/** SEC-02 body (API design 10.4j). */
export class CreateSectionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  classId!: string;

  @ApiProperty({ format: 'uuid', description: 'A predefined section of the platform masters' })
  @IsUUID()
  predefinedSectionId!: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 30,
    description: 'Defaults to the predefined name',
  })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  displayName?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 1,
    maximum: MAX_CAPACITY,
    description: 'A warning only: nothing stops enrolment above it',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CAPACITY)
  capacity?: number | null;
}

/** SEC-03 body: an omitted field stays; `capacity` is cleared with `null`. */
export class UpdateSectionDto extends VersionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 30 })
  @WhenPresent()
  @IsString()
  @Length(1, 30)
  displayName?: string;

  @ApiPropertyOptional({ nullable: true, minimum: 1, maximum: MAX_CAPACITY })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CAPACITY)
  capacity?: number | null;
}
