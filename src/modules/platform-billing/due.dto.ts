import { applyDecorators } from '@nestjs/common';
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
import { VersionDto } from '../../common/validation/version.dto.js';
import { WhenPresent } from '../../common/validation/when-present.js';
import { DueStatus, PAYMENT_MODES } from './due.rules.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A signed adjustment: a plain decimal string with exactly two decimals (API design 7.5). */
const SIGNED_MONEY = /^-?\d{1,8}\.\d{2}$/;

/** The most students one due may count; the amount columns hold the rest. */
export const MAX_STUDENT_COUNT = 1_000_000;

const IsCalendarDate = () =>
  applyDecorators(IsString(), Matches(DATE_ONLY), IsISO8601({ strict: true }));
const IsStudentCount = () => applyDecorators(IsInt(), Min(0), Max(MAX_STUDENT_COUNT));
const IsNote = () => applyDecorators(IsString(), Length(1, 500));
const IsAdjustment = () => applyDecorators(IsString(), Matches(SIGNED_MONEY));

/** PLT-26 body (API design 10.22). `invoiceFileId` arrives with the Files module. */
export class RaiseDueDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  institutionId!: string;

  @ApiProperty({ example: '2026-04-01' })
  @IsCalendarDate()
  periodStartDate!: string;

  @ApiProperty({ example: '2027-03-31', description: 'On or after the start' })
  @IsCalendarDate()
  periodEndDate!: string;

  @ApiProperty({ minimum: 0, maximum: MAX_STUDENT_COUNT, description: 'Prefilled from PLT-24' })
  @IsStudentCount()
  studentCount!: number;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 500,
    description: 'Required when the count differs from the automatic one',
  })
  @IsOptional()
  @IsNote()
  studentCountNote?: string | null;

  @ApiPropertyOptional({
    example: '-500.00',
    default: '0.00',
    description: 'Signed; the total may not go below zero',
  })
  @IsOptional()
  @IsAdjustment()
  adjustmentAmount?: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 500,
    description: 'Required when the adjustment is not zero',
  })
  @IsOptional()
  @IsNote()
  adjustmentNote?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-05-15' })
  @IsOptional()
  @IsCalendarDate()
  dueDate?: string | null;
}

/**
 * PLT-28 body: the `version` read, and any of the fields of a raise except the
 * Institution. A field left out stays; a note or the due date set to `null` is
 * cleared. A new `periodStartDate` takes the rate in force on that day.
 */
export class UpdateDueDto extends VersionDto {
  @ApiPropertyOptional({ example: '2026-04-01' })
  @WhenPresent()
  @IsCalendarDate()
  periodStartDate?: string;

  @ApiPropertyOptional({ example: '2027-03-31' })
  @WhenPresent()
  @IsCalendarDate()
  periodEndDate?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_STUDENT_COUNT })
  @WhenPresent()
  @IsStudentCount()
  studentCount?: number;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @IsOptional()
  @IsNote()
  studentCountNote?: string | null;

  @ApiPropertyOptional({ example: '-500.00' })
  @WhenPresent()
  @IsAdjustment()
  adjustmentAmount?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @IsOptional()
  @IsNote()
  adjustmentNote?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-05-15' })
  @IsOptional()
  @IsCalendarDate()
  dueDate?: string | null;
}

/** PLT-29 body: when the money arrived, how, and the reference to find it by (a bank reference, a cheque number). */
export class MarkDuePaidDto extends VersionDto {
  @ApiProperty({ example: '2026-05-10', description: 'Not in the future' })
  @IsCalendarDate()
  paidDate!: string;

  @ApiProperty({ enum: PAYMENT_MODES, description: '1 Cash, 2 Bank transfer, 3 UPI, 4 Cheque' })
  @IsIn(PAYMENT_MODES)
  paymentMode!: number;

  @ApiPropertyOptional({ nullable: true, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  paymentReference?: string | null;
}

/** PLT-30 body. */
export class CancelDueDto extends VersionDto {
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString()
  @Length(5, 500)
  reason!: string;
}

/** PLT-24 query: the period to prefill a due for. Query values are strings. */
export class DueQuoteQueryDto {
  @ApiProperty({ example: '2026-04-01' })
  @IsCalendarDate()
  periodStartDate!: string;

  @ApiProperty({ example: '2027-03-31' })
  @IsCalendarDate()
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
    enum: Object.values(DueStatus),
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
  @IsIn(Object.values(DueStatus), { each: true })
  dueStatus?: number[];
}
