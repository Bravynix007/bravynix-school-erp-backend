import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

/** A phone number as the API carries it (API design 7.3, DDD 11.2). */
export class PhoneDto {
  @ApiProperty({ example: '91', description: '1 to 4 digits, without +' })
  @Matches(/^\d{1,4}$/)
  countryCode!: string;

  @ApiProperty({ example: '9876543210', description: '6 to 15 digits' })
  @Matches(/^\d{6,15}$/)
  number!: string;
}

export interface Phone {
  countryCode: string;
  number: string;
}
