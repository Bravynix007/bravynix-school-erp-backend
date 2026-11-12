import { Body, Controller, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { RevealIdentityDto } from './identity.dto.js';
import type { RevealResource } from './identity.resource.js';
import { StudentIdentityDto } from './student-identity.dto.js';
import type { StudentIdentityResource } from './student-identity.resource.js';
import { StudentIdentityService } from './student-identity.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** STU-10 and STU-11 (API design 6.8, 10.9): the Aadhaar and birth certificate numbers of a student. */
@ApiTags('Students')
@Controller('students')
export class StudentIdentityController {
  constructor(private readonly identity: StudentIdentityService) {}

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STU-10',
    rule: 'Sets or clears the Aadhaar and birth certificate numbers of an active student and answers with the Aadhaar number masked only; one record per Aadhaar number in the Institution, a number held at another Institution of the Society is a warning',
  })
  @Put(':studentId/identity')
  set(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Body() body: StudentIdentityDto,
  ): Promise<ApiResult<StudentIdentityResource>> {
    return this.identity.set(principal, studentId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STU-11',
    rule: 'Shows the whole Aadhaar number of a student to an admin who gives a reason; audited before the answer, at most ten a day for each admin',
  })
  @HttpCode(HttpStatus.OK)
  @Post(':studentId/identity/reveal')
  reveal(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Body() body: RevealIdentityDto,
  ): Promise<RevealResource> {
    return this.identity.reveal(principal, studentId, body);
  }
}
