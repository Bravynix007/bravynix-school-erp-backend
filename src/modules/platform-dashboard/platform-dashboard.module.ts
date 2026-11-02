import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';
import { PlatformDashboardController } from './platform-dashboard.controller.js';

/** The Super Admin dashboard (PRD 9.6): reads what Tenancy and Platform billing count and owns no data. */
@Module({
  controllers: [PlatformDashboardController],
  providers: [DashboardService],
})
export class PlatformDashboardModule {}
