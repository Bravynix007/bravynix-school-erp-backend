import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';

/** STF-15 body: the title shown on the Documents tab, and a Ready file of purpose 6 uploaded for the home Institution. */
export class CreateStaffDocumentDto {
  @ApiProperty({ minLength: 1, maxLength: 150 })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  title!: string;

  @ApiProperty({ format: 'uuid', description: 'A Ready file of purpose 6 in the home Institution' })
  @LowerCaseUuid()
  @IsUUID()
  fileId!: string;
}
