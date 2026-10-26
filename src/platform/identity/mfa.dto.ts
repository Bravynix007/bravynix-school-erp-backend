import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * AUTH-03 body (API design 10.2a). Only the length is checked: a token of the
 * wrong shape gets the same 401 `MFA_TOKEN_EXPIRED` as an unknown one.
 */
export class EnrolMfaDto {
  @ApiProperty({ example: 'mfa_…', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  mfaToken!: string;
}

/** AUTH-04 body (API design 10.2b). */
export class VerifyMfaDto extends EnrolMfaDto {
  @ApiProperty({ example: '482913', description: 'Exactly 6 digits' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
