import { ApiProperty, PickType } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { LowerCaseUuid } from '../../common/validation/lower-case-uuid.js';

/** INS-09: the staff member the Society Owner promotes to Admin of the Institution in the path. */
export class GrantAdminDto {
  @ApiProperty({ format: 'uuid' })
  @LowerCaseUuid()
  @IsUUID()
  staffMemberId!: string;
}

/** INS-08: a page of the Institution's Admins; the list has no search or sort of its own. */
export class ListAdminsQueryDto extends PickType(PageQueryDto, ['page', 'limit'] as const) {}
