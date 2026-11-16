import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsUUID } from 'class-validator';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { PageQueryDto } from '../../common/pagination/pagination.js';

/** The kinds of import: 1 Students. */
export const IMPORT_TYPES = [1] as const;

/** IMP-02 body (API design 10.8): the uploaded file and the academic year the students join. */
export class StartImportDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  institutionId!: string;

  @ApiProperty({ enum: IMPORT_TYPES, description: '1 Students' })
  @IsInt()
  @IsIn(IMPORT_TYPES)
  importType!: number;

  @ApiProperty({
    format: 'uuid',
    description: 'A Ready file of purpose 12 that the caller uploaded',
  })
  @LowerCaseUuid()
  @IsUUID()
  fileId!: string;

  @ApiProperty({ format: 'uuid', description: 'An active academic year of the Institution' })
  @LowerCaseUuid()
  @IsUUID()
  academicYearId!: string;
}

/** IMP-04 query: the Institution, and a page. */
export class ListImportsQueryDto extends PageQueryDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  institutionId!: string;
}
