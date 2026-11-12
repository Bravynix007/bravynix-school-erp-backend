import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { UpdateGuardianDto } from './guardian.dto.js';
import { GuardianService } from './guardian.service.js';
import { GuardianDto } from './student.dto.js';
import type { GuardianResource } from './student.resource.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** GDN-01 to GDN-04 (API design 9.6): the guardians of a student, who sign in as the child's Student / Parent. */
@ApiTags('Guardians')
@Controller()
export class GuardianController {
  constructor(private readonly guardians: GuardianService) {}

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'GDN-01',
    rule: 'Lists the active guardians of a student whose Institution the caller reaches, the primary first; a teacher never reads them',
  })
  @Get('students/:studentId/guardians')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
  ): Promise<GuardianResource[]> {
    return this.guardians.list(principal, studentId);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'GDN-02',
    rule: 'Adds a guardian to an active student, up to five; an email links a parent login, and the primary place can be handed to the new guardian',
  })
  @Post('students/:studentId/guardians')
  add(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Body() body: GuardianDto,
  ): Promise<ApiResult<GuardianResource>> {
    return this.guardians.add(principal, studentId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'GDN-03',
    rule: 'Edits a guardian of an active student, versioned; an email relinks the login, moves the link to the person it belongs to or changes the own email of a person who holds only this link',
  })
  @Patch('guardians/:guardianId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('guardianId', UuidParamPipe) guardianId: string,
    @Body() body: UpdateGuardianDto,
  ): Promise<GuardianResource> {
    return this.guardians.update(principal, guardianId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'GDN-04',
    rule: 'Removes a guardian who is not the primary or the last one; the person loses the child at once, and their parent sessions end when it was their last child',
  })
  @Delete('guardians/:guardianId')
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('guardianId', UuidParamPipe) guardianId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.guardians.remove(principal, guardianId);
  }
}
