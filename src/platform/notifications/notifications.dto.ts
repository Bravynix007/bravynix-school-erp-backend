import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../../common/pagination/pagination.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';

/** 1 Only for you, 2 All, 3 All teachers, 4 All students (DDD 9.8). */
export const INBOX_TABS = [1, 2, 3, 4] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

/** The tab a request names, when it names one. A query value is a string, so it takes the number transform. */
export class TabQueryDto {
  @ApiProperty({
    required: false,
    enum: INBOX_TABS,
    description: '1 Only for you ... 4 All students',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(INBOX_TABS)
  tab?: InboxTab;
}

/** NTF-01 query: a tab (the first, "Only for you", by default), optionally one child, a page at a time. */
export class ListNotificationsQueryDto extends TabQueryDto {
  @ApiProperty({ required: false, format: 'uuid', description: 'Only what is about this child' })
  @IsOptional()
  @LowerCaseUuid()
  @IsUUID()
  studentId?: string;

  @ApiProperty({ required: false, description: 'The nextCursor of the previous page' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit: number = DEFAULT_LIMIT;
}

/** ME-04 body: this session's push token. */
export class PushDeviceDto {
  @ApiProperty({ minLength: 1, maxLength: 512 })
  @IsString()
  @Length(1, 512)
  fcmToken!: string;

  @ApiProperty({ enum: [1, 2], description: '1 Android, 2 iOS' })
  @IsInt()
  @IsIn([1, 2])
  platform!: 1 | 2;

  @ApiProperty({ required: false, maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  appVersion?: string;

  @ApiProperty({
    required: false,
    minLength: 2,
    maxLength: 5,
    description: 'The language of push text',
    default: 'en',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(5)
  language?: string;
}
