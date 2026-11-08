import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateStaffDto, UpdateStaffDto } from './staff.dto.js';
import type { StaffResource } from './staff.resource.js';
import { StaffService } from './staff.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** STF-02 to STF-05 (API design 9.5): the staff of a Society. */
@ApiTags('Staff')
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-02',
    rule: 'Adds a staff member at an Institution the caller reaches, with the login by email; the welcome mail goes after the commit',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateStaffDto,
  ): Promise<ApiResult<StaffResource>> {
    return ApiResult.created(await this.staff.create(principal, body));
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-03',
    rule: 'The profile of a staff member whose home Institution the caller reaches; a teacher’s own profile arrives with the teacher sign-in',
  })
  @Get(':staffMemberId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
  ): Promise<StaffResource> {
    return this.staff.get(principal, staffMemberId);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-04',
    rule: 'Edits an active staff member by version; the education and emergency contact lists are replaced whole when sent',
  })
  @Patch(':staffMemberId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
    @Body() body: UpdateStaffDto,
  ): Promise<StaffResource> {
    return this.staff.update(principal, staffMemberId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-05',
    rule: 'Deactivates a staff member and ends their sessions as staff; not the caller’s own record',
  })
  @Delete(':staffMemberId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.staff.deactivate(principal, staffMemberId);
  }
}
