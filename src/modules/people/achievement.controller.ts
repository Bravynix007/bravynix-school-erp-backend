import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateAchievementDto, ListAchievementsQueryDto } from './achievement.dto.js';
import type { AchievementResource, AchievementsResource } from './achievement.resource.js';
import { AchievementService } from './achievement.service.js';

const GIVERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin, RoleCode.TeacherStaff];

/** ACH-01 to ACH-03 (API design 9.6): the stars of a student. */
@ApiTags('Achievements')
@Controller()
export class AchievementController {
  constructor(private readonly achievements: AchievementService) {}

  @Policy({
    roles: GIVERS,
    scope: 'institution',
    operationId: 'ACH-01',
    rule: 'The stars earned by tier and the stars of a student whose Institution the caller reaches, newest first; a Teacher or Staff member reads a student of their own sections only (403 NOT_ASSIGNED)',
  })
  @Get('students/:studentId/achievements')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Query() query: ListAchievementsQueryDto,
  ): Promise<AchievementsResource> {
    return this.achievements.list(principal, studentId, query);
  }

  @Policy({
    roles: GIVERS,
    scope: 'institution',
    operationId: 'ACH-02',
    rule: 'Gives a Silver, Gold or Platinum star to an active student who has an open placement (422 NO_CURRENT_PLACEMENT otherwise); a Teacher or Staff member only for a student of their own sections',
  })
  @Post('students/:studentId/achievements')
  async add(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Body() body: CreateAchievementDto,
  ): Promise<ApiResult<AchievementResource>> {
    return ApiResult.created(await this.achievements.add(principal, studentId, body));
  }

  @Policy({
    roles: GIVERS,
    scope: 'institution',
    operationId: 'ACH-03',
    rule: 'Removes a star of an Institution the caller reaches; a Teacher or Staff member removes only a star they gave; nothing is deleted',
  })
  @Delete('achievements/:achievementId')
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('achievementId', UuidParamPipe) achievementId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.achievements.remove(principal, achievementId);
  }
}
