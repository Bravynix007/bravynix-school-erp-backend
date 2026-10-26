import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * AUTH-05 body on mobile (API design 10.3). Only the length is checked: a
 * token of the wrong shape gets the same 401 as an unknown one.
 */
export class RefreshTokenDto {
  @ApiProperty({ example: 'rt_…', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  refreshToken!: string;
}
