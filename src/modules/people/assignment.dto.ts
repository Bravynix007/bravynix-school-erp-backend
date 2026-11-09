import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsUUID, ValidateIf } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';

/** STF-09 body: the section the staff member leads in the year, or `null` to end the assignment. */
export class SetClassTeacherDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty({ format: 'uuid', nullable: true, description: '`null` ends the assignment' })
  @LowerCaseUuid()
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsUUID()
  sectionId!: string | null;
}

/** ASG-02 body: a teacher, a section of their home Institution and a subject they can teach, for one year. */
export class CreateTeachingAssignmentDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  staffMemberId!: string;

  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  sectionId!: string;

  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  subjectId!: string;
}

/** ASG-01 query: one Institution, one year (the current one when absent), a page. No search and no sort. */
export class ListTeachingAssignmentsQueryDto extends PickType(PageQueryDto, ['page', 'limit']) {
  @ApiProperty({ format: 'uuid', description: 'An Institution the caller reaches' })
  @LowerCaseUuid()
  @IsUUID()
  institutionId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The current year of the Institution when absent',
  })
  @LowerCaseUuid()
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @LowerCaseUuid()
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @LowerCaseUuid()
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A teacher reads their own assignments only',
  })
  @LowerCaseUuid()
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsUUID()
  staffMemberId?: string;
}
