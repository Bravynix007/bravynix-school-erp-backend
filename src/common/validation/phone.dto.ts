import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

/** The digits of a phone number, without the country code: 6 to 15. */
export const PHONE_NUMBER = /^\d{6,15}$/;

/** A phone number as the API carries it (API design 7.3, DDD 11.2). */
export class PhoneDto {
  @ApiProperty({ example: '91', description: '1 to 4 digits, without +' })
  @Matches(/^\d{1,4}$/)
  countryCode!: string;

  @ApiProperty({ example: '9876543210', description: '6 to 15 digits' })
  @Matches(PHONE_NUMBER)
  number!: string;
}

export interface Phone {
  countryCode: string;
  number: string;
}
