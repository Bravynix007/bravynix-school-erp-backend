import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';

export const BLOCK_SECTION_NAMES = ['owners', 'staff', 'students'] as const;
export type BlockSectionName = (typeof BLOCK_SECTION_NAMES)[number];

export const BLOCK_SORT_FIELDS = ['blockedAt'] as const;

/**
 * PLT-42 body. `institutionId` belongs to `staff` and `students` and is not
 * allowed for `owners`; the service checks that pairing.
 */
export class CreateAccessBlockDto {
  @ApiProperty({ enum: BLOCK_SECTION_NAMES })
  @IsIn(BLOCK_SECTION_NAMES)
  section!: BlockSectionName;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  societyId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for staff and students' })
  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @ApiProperty({ minLength: 1, maxLength: 500, example: 'Annual fee unpaid' })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

/** PLT-44 query: `q` matches the reason; `sort` is `blockedAt` (newest first by default). */
export class ListAccessBlocksQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  societyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({
    enum: BLOCK_SECTION_NAMES,
    isArray: true,
    description: 'Repeat for several',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? value : [value]))
  @IsArray()
  @IsIn(BLOCK_SECTION_NAMES, { each: true })
  section?: BlockSectionName[];
}
