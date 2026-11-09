import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { BooleanQuery } from '../../common/validation/boolean-query.js';

/**
 * The filters the Society and Institution lists share (API design 10.4b,
 * 10.4c). Query values arrive as strings, so these do convert them; a value
 * that is not a number or a boolean fails validation as it stands.
 */
export class TenantRootListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: [0, 1], isArray: true, description: 'Repeat for both' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : [value]).map((item: unknown) =>
      item === '' ? item : Number(item),
    ),
  )
  @IsArray()
  @IsIn([0, 1], { each: true })
  status?: number[];

  @ApiPropertyOptional({ description: 'Only with a blocked section, or only with none' })
  @BooleanQuery()
  blocked?: boolean;
}
