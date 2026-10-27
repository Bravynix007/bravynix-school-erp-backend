import { ApiProperty, IntersectionType } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { VersionDto } from './version.dto.js';

/** Why an action is taken: kept in the audit log, and shown to the people it affects where the endpoint says so. */
export class ReasonDto {
  @ApiProperty({ minLength: 1, maxLength: 500, example: 'Annual fee unpaid' })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

/** The version read and why: an account block (PLT-15). */
export class VersionedReasonDto extends IntersectionType(VersionDto, ReasonDto) {}
