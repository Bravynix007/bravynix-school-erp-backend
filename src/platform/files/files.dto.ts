import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { PURPOSE_CODES } from './file-purposes.js';

/** FIL-01 body (API design 15.1). The size is checked against the 5 MB limit by the service, so it is a 413. */
export class RequestUploadDto {
  @ApiProperty({ enum: PURPOSE_CODES, description: 'DDD 16.2: 3 Student photo ... 12 Import CSV' })
  @IsInt()
  @IsIn(PURPOSE_CODES)
  purpose!: number;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  institutionId!: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @Length(1, 100)
  contentType!: string;

  @ApiProperty({ minimum: 1, example: 184_320 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  sizeBytes!: number;

  @ApiProperty({ minLength: 1, maxLength: 255, example: 'admission-form.pdf' })
  @IsString()
  @Length(1, 255)
  fileName!: string;
}
