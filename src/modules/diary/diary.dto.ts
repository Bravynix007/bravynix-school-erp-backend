import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { IsCalendarDate } from '../../common/validation/calendar-date.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';
import { NotBlank } from '../../common/validation/not-blank.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import { MAX_DESCRIPTION_LENGTH } from './diary.rules.js';

/** DIA-01 query: a section's entries on a date, or, for a parent, their own child's section's. */
export class ListDiaryQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'The section whose entries to read' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A parent’s own child, whose section’s entries are read (parents only)',
  })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  studentId?: string;

  @ApiProperty({ format: 'date', example: '2026-11-17' })
  @IsCalendarDate()
  date!: string;
}

/** DIA-05 query: the section whose subjects the caller may write the diary for. */
export class ListDiarySubjectsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  sectionId!: string;
}

/** DIA-02 body (API design 10.14a). */
export class CreateDiaryEntryDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  sectionId!: string;

  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  subjectId!: string;

  @ApiProperty({ format: 'date', example: '2026-11-17' })
  @IsCalendarDate()
  diaryDate!: string;

  @ApiProperty({ minLength: 1, maxLength: MAX_DESCRIPTION_LENGTH })
  @IsString()
  @Length(1, MAX_DESCRIPTION_LENGTH)
  @NotBlank()
  description!: string;
}

/** DIA-03 body: an omitted field stays. The section is not editable. */
export class UpdateDiaryEntryDto extends VersionDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @WhenPresent()
  @LowerCaseUuid()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-11-17' })
  @WhenPresent()
  @IsCalendarDate()
  diaryDate?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: MAX_DESCRIPTION_LENGTH })
  @WhenPresent()
  @IsString()
  @Length(1, MAX_DESCRIPTION_LENGTH)
  @NotBlank()
  description?: string;
}
