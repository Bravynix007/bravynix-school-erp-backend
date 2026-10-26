import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { VersionDto } from '../../common/validation/version.dto.js';

/** A person added by email (PLT-03 owners, PLT-09, PLT-13). The names are optional; the first sign-in or the People module fills them later. */
export class NewPersonDto {
  @ApiProperty({ maxLength: 254, example: 'asha.rao@example.com' })
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'Asha' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'Rao' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;
}

/** PLT-17 body: the new email and the version read. */
export class ChangeEmailDto extends VersionDto {
  @ApiProperty({ maxLength: 254, example: 'asha.rao@example.com' })
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
