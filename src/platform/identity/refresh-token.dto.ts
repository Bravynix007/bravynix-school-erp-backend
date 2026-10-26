import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * AUTH-05 body (API design 10.3): the token on mobile, nothing on the console,
 * which sends its cookie. Only the length is checked: a token of the wrong
 * shape gets the same 401 as an unknown one.
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({ example: 'rt_…', maxLength: 200 })
  // Absent is allowed (the console); a null or any other present value must be a string.
  @ValidateIf((body: RefreshTokenDto) => body.refreshToken !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  refreshToken?: string;
}
