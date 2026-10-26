import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ClientType } from './auth-codes.js';

/** The phone or tablet signing in (API design 10.2). */
export class DeviceDto {
  @ApiProperty({ enum: [1, 2], description: '1 Android, 2 iOS' })
  @IsInt()
  @IsIn([1, 2])
  platform!: 1 | 2;

  @ApiPropertyOptional({ maxLength: 100, example: 'Asha’s Pixel 8' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @ApiProperty({ maxLength: 20, example: '1.4.0' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  appVersion!: string;
}

/**
 * AUTH-02 body (API design 10.2). No `@Type` on primitives: a body is JSON,
 * so a code sent as the number 123456 must fail as INVALID_TYPE. The one
 * `@Type` is the nested class, which class-validator needs to reach inside.
 */
export class VerifyOtpDto {
  @ApiProperty({ maxLength: 254, example: 'asha.rao@example.com' })
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: '482913', description: 'Exactly 6 digits' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;

  @ApiProperty({ enum: [1, 2], description: '1 Mobile app, 2 Console' })
  @IsInt()
  @IsIn([ClientType.Mobile, ClientType.Console])
  clientType!: ClientType;

  @ApiPropertyOptional({ type: DeviceDto, description: 'Required for the mobile app' })
  @ValidateIf((body: VerifyOtpDto) => body.clientType === ClientType.Mobile)
  @IsDefined()
  @ValidateNested()
  @Type(() => DeviceDto)
  device?: DeviceDto;
}
