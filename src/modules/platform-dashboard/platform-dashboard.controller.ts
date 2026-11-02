import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import type { PlatformDashboard } from './dashboard.resource.js';
import { DashboardService } from './dashboard.service.js';

/** PLT-01: the Super Admin's dashboard (PRD 9.6). */
@ApiTags('Platform: Dashboard')
@Controller('platform/dashboard')
export class PlatformDashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @superAdminPolicy(
    'PLT-01',
    'Societies, Institutions, dues outstanding and collected this and last month; students and AI reports are null until their modules exist',
  )
  @Get()
  get(@CurrentPrincipal() principal: Principal): Promise<PlatformDashboard> {
    return this.dashboard.get(principal);
  }
}
