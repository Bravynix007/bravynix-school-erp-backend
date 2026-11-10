import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * STF-11 body: the Aadhaar number, or `null` to clear it. Spaces and hyphens may separate the digits; what is a valid
 * number (twelve digits, a first digit of 2 to 9, the Verhoeff check digit) is the service's rule, which answers 422
 * `INVALID_AADHAAR`. The bank account, IFSC and branch of the first design are not built.
 */
export class SetIdentityDto {
  @ApiProperty({ nullable: true, maxLength: 30, description: '`null` clears the number' })
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsString()
  @MaxLength(30)
  aadhaar!: string | null;
}

/** The numbers STF-12 can reveal. */
export const REVEALABLE_FIELDS = ['aadhaar'] as const;

/** STF-12 body: which number, and why (10 to 500 characters, kept in the audit entry). */
export class RevealIdentityDto {
  @ApiProperty({ enum: REVEALABLE_FIELDS })
  @IsIn(REVEALABLE_FIELDS)
  field!: (typeof REVEALABLE_FIELDS)[number];

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}
