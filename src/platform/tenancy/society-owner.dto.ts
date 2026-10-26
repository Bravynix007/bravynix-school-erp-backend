import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';

/** PLT-11 query: `q` matches name or email; `sort` is one of `name`, `email`, `createdAt`. */
export class ListOwnersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only the Owners of this Society' })
  @IsOptional()
  @IsUUID()
  societyId?: string;
}
