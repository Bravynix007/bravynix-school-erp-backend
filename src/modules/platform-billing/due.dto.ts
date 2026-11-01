import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A signed adjustment: a plain decimal string with exactly two decimals (API design 7.5). */
const SIGNED_MONEY = /^-?\d{1,8}\.\d{2}$/;

/** The most students one due may count; the amount columns hold the rest. */
export const MAX_STUDENT_COUNT = 1_000_000;

/** PLT-26 body (API design 10.22). `invoiceFileId` arrives with the Files module. */
export class RaiseDueDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  institutionId!: string;

  @ApiProperty({ example: '2026-04-01' })
  @IsString()
  @Matches(DATE_ONLY)
  @IsISO8601({ strict: true })
  periodStartDate!: string;

  @ApiProperty({ example: '2027-03-31', description: 'On or after the start' })
  @IsString()
  @Matches(DATE_ONLY)
  @IsISO8601({ strict: true })
  periodEndDate!: string;

  @ApiProperty({ minimum: 0, maximum: MAX_STUDENT_COUNT, description: 'Prefilled from PLT-24' })
  @IsInt()
  @Min(0)
  @Max(MAX_STUDENT_COUNT)
  studentCount!: number;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 500,
    description: 'Required when the count differs from the automatic one',
  })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  studentCountNote?: string | null;

  @ApiPropertyOptional({
    example: '-500.00',
    default: '0.00',
    description: 'Signed; the total may not go below zero',
  })
  @IsOptional()
  @IsString()
  @Matches(SIGNED_MONEY)
  adjustmentAmount?: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 500,
    description: 'Required when the adjustment is not zero',
  })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  adjustmentNote?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-05-15' })
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  @IsISO8601({ strict: true })
  dueDate?: string | null;
}

/** PLT-24 query: the period to prefill a due for. Query values are strings. */
export class DueQuoteQueryDto {
  @ApiProperty({ example: '2026-04-01' })
  @IsString()
  @Matches(DATE_ONLY)
  @IsISO8601({ strict: true })
  periodStartDate!: string;

  @ApiProperty({ example: '2027-03-31' })
  @IsString()
  @Matches(DATE_ONLY)
  @IsISO8601({ strict: true })
  periodEndDate!: string;
}

export const DUE_SORT_FIELDS = [
  'createdAt',
  'dueDate',
  'invoiceNo',
  'periodStartDate',
  'totalAmount',
] as const;
export type DueSortField = (typeof DUE_SORT_FIELDS)[number];

/** PLT-25 query (API design 13.1). Query values arrive as strings, so the status list converts them. */
export class ListDuesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  societyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({
    enum: [0, 1, 2],
    isArray: true,
    description: '0 Cancelled, 1 Due, 2 Paid; repeat for several',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : [value]).map((item: unknown) =>
      item === '' ? item : Number(item),
    ),
  )
  @IsArray()
  @IsIn([0, 1, 2], { each: true })
  dueStatus?: number[];
}
