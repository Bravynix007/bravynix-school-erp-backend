import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';

/**
 * STF-15 and DOC-02 body: the title shown on the Documents tab, and a Ready file uploaded for the owner's Institution
 * (purpose 6 for a staff member, 5 for a student).
 */
export class CreateDocumentDto {
  @ApiProperty({ minLength: 1, maxLength: 150 })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  title!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'A Ready file of purpose 6 (staff) or 5 (student) in the owner’s Institution',
  })
  @LowerCaseUuid()
  @IsUUID()
  fileId!: string;
}
