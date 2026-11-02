import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';

/** SUB-02 body (API design 10.4i). */
export class CreateSubjectDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Mathematics' })
  @IsString()
  @Length(1, 100)
  name!: string;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 50, example: 'MATH' })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  code?: string | null;
}

/** SUB-03 body: an omitted field stays; `code` is cleared with `null`. */
export class UpdateSubjectDto extends VersionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @WhenPresent()
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 50 })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  code?: string | null;
}
