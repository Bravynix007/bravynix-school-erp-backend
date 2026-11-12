import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { NotBlank } from '../../common/validation/not-blank.js';

/**
 * The numbers of a student's identity, as STU-02 takes them (`identity`) and STU-10 sets them. A number left out stays
 * as it is; `null` clears it. What is a valid Aadhaar number (twelve digits, a first digit of 2 to 9, the Verhoeff
 * check digit) is the service's rule, which answers 422 `INVALID_AADHAAR`. The birth certificate number is kept as
 * typed, up to 50 characters.
 */
export class StudentIdentityDto {
  @ApiPropertyOptional({
    nullable: true,
    maxLength: 30,
    description: 'Twelve digits, spaces or hyphens allowed; `null` clears the number',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  aadhaarNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @NotBlank()
  birthCertificateNumber?: string | null;
}
