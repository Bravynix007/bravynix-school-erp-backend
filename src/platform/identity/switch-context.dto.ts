import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUUID } from 'class-validator';

/**
 * AUTH-06 body (API design 10.4). `societyId` is required for roles 2 to 4
 * and must be absent for role 5; the service checks that pairing, because it
 * depends on `roleCode`. No `@Type` on primitives: a body is JSON.
 */
export class SwitchContextDto {
  @ApiProperty({ enum: [2, 3, 4, 5], description: 'Role 1 acts on the console only' })
  @IsInt()
  @IsIn([2, 3, 4, 5])
  roleCode!: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for roles 2 to 4, absent for 5' })
  @IsOptional()
  @IsUUID()
  societyId?: string;
}
