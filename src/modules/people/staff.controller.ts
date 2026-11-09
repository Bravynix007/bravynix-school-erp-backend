import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { SetClassTeacherDto } from './assignment.dto.js';
import type { ClassTeacherResource } from './assignment.resource.js';
import { AssignmentService } from './assignment.service.js';
import { ChangeEmailDto } from '../../platform/identity/index.js';
import {
  CreateStaffDto,
  ListStaffQueryDto,
  SetStaffInstitutionsDto,
  SetStaffSubjectsDto,
  UpdateStaffDto,
} from './staff.dto.js';
import type { StaffResource, StaffSummary } from './staff.resource.js';
import { StaffService } from './staff.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];
/** A teacher reads their own profile (STF-03, "TS self"). */
const ADMINS_AND_SELF = [...ADMINS, RoleCode.TeacherStaff];

/** STF-01 to STF-10 and STF-13 (API design 9.5): the staff of a Society. */
@ApiTags('Staff')
@Controller('staff')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly assignments: AssignmentService,
  ) {}

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-01',
    rule: 'Lists the staff whose home Institution the caller reaches, a page at a time, with search by name or Employee ID',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListStaffQueryDto,
  ): Promise<ApiResult<StaffSummary[]>> {
    return this.staff.list(principal, query);
  }

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
    roles: ADMINS_AND_SELF,
    scope: 'institution',
    operationId: 'STF-03',
    rule: 'The profile of a staff member whose home Institution the caller reaches; a teacher reads only their own',
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

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-13',
    rule: 'Changes an active staff member’s login email by version and ends their sessions; an email that belongs to a person moves the record to them',
  })
  @Put(':staffMemberId/email')
  changeEmail(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
    @Body() body: ChangeEmailDto,
  ): Promise<StaffResource> {
    return this.staff.changeEmail(principal, staffMemberId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-06',
    rule: 'Blocks the staff role of an active staff member in this Society and ends their sessions in it; not the caller’s own record',
  })
  @HttpCode(HttpStatus.OK)
  @Post(':staffMemberId/block')
  block(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
  ): Promise<StaffResource> {
    return this.staff.block(principal, staffMemberId);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-07',
    rule: 'Lifts the block on the staff role of an active staff member; not the caller’s own record',
  })
  @HttpCode(HttpStatus.OK)
  @Post(':staffMemberId/unblock')
  unblock(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
  ): Promise<StaffResource> {
    return this.staff.unblock(principal, staffMemberId);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-08',
    rule: 'Replaces the subjects an active staff member can teach with the list sent; each new subject must be an active subject of the Society',
  })
  @Put(':staffMemberId/subjects')
  setSubjects(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
    @Body() body: SetStaffSubjectsDto,
  ): Promise<StaffResource> {
    return this.staff.setSubjects(principal, staffMemberId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-09',
    rule: 'Sets the section an active staff member leads in an academic year of their home Institution, or ends it with null',
  })
  @Put(':staffMemberId/class-teacher')
  setClassTeacher(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
    @Body() body: SetClassTeacherDto,
  ): Promise<ClassTeacherResource | null> {
    return this.assignments.setClassTeacher(principal, staffMemberId, body);
  }

  @Policy({
    roles: [RoleCode.SocietyOwner],
    scope: 'institution',
    operationId: 'STF-10',
    rule: 'Replaces the extra Institutions an active staff member may see with the list sent; only a Society Owner, and not the home Institution',
  })
  @Put(':staffMemberId/institutions')
  setInstitutions(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
    @Body() body: SetStaffInstitutionsDto,
  ): Promise<StaffResource> {
    return this.staff.setInstitutions(principal, staffMemberId, body);
  }
}
