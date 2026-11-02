import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';

/** The most classes one bulk request adds (API design 10.4j). */
export const MAX_BULK_CLASSES = 50;

/** CLS-01 query: the Institution whose classes are listed (API design 6.5). */
export class ListClassesQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  institutionId!: string;
}

/** One class to add: the part CLS-02 and CLS-03 share. */
export class ClassInputDto {
  @ApiProperty({ format: 'uuid', description: 'A predefined class of the platform masters' })
  @IsUUID()
  predefinedClassId!: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 30,
    description: 'Pre-University classes only (for example PCMC)',
  })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  streamName?: string | null;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 60,
    description: 'Defaults to the predefined name, with the stream after it',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  displayName?: string | null;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 50 })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  code?: string | null;
}

/** CLS-02 body (API design 10.4j). */
export class CreateClassDto extends ClassInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  institutionId!: string;
}

/** CLS-03 body: up to 50 classes, all or nothing. */
export class CreateClassesDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  institutionId!: string;

  @ApiProperty({ type: [ClassInputDto], minItems: 1, maxItems: MAX_BULK_CLASSES })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_CLASSES)
  @ValidateNested({ each: true })
  @Type(() => ClassInputDto)
  classes!: ClassInputDto[];
}

/** CLS-04 body: an omitted field stays; `code` is cleared with `null`. The predefined class and the stream never change. */
export class UpdateClassDto extends VersionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @WhenPresent()
  @IsString()
  @Length(1, 60)
  displayName?: string;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 50 })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  code?: string | null;
}
