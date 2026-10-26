import { ApiProperty, ApiPropertyOptional, IntersectionType, OmitType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * An address as the API carries it (API design 7.3); the master-list ids join
 * when the masters exist. Optional text is cleared with `null`, never `""`.
 */
export class AddressDto {
  @ApiPropertyOptional({ maxLength: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  line1?: string | null;

  @ApiPropertyOptional({ maxLength: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  line2?: string | null;

  @ApiPropertyOptional({ maxLength: 10, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  pincode?: string | null;
}

class RequiredLine1Dto {
  @ApiProperty({ minLength: 1, maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  line1!: string;
}

/** An address whose first line is required, as an Institution's is (PRD 7.1). */
export class RequiredAddressDto extends IntersectionType(
  RequiredLine1Dto,
  OmitType(AddressDto, ['line1'] as const),
) {}
