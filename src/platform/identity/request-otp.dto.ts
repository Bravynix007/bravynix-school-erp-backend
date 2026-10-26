import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsInt, IsNotEmpty, MaxLength } from 'class-validator';
import { ClientType } from './auth-codes.js';

/** AUTH-01 body (API design 10.1). No `@Type`: a body is JSON, so "1" must fail as INVALID_TYPE. */
export class RequestOtpDto {
  @ApiProperty({ maxLength: 254, example: 'asha.rao@example.com' })
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ enum: [1, 2], description: '1 Mobile app, 2 Console' })
  @IsInt()
  @IsIn([ClientType.Mobile, ClientType.Console])
  clientType!: ClientType;
}
