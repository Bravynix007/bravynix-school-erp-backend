import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../platform/idempotency/index.js';
import { NumberingModule } from '../../platform/numbering/index.js';
import { DueRepository } from './due.repository.js';
import { DueService } from './due.service.js';
import { PlatformDueController } from './platform-due.controller.js';
import { PlatformPriceRateController } from './platform-price-rate.controller.js';
import { PriceRateRepository } from './price-rate.repository.js';
import { PriceRateService } from './price-rate.service.js';

/** Platform billing (PRD 9.2, 9.3): what BravyNix charges each Institution. Rates and dues. */
@Module({
  imports: [IdempotencyModule, NumberingModule],
  controllers: [PlatformPriceRateController, PlatformDueController],
  providers: [PriceRateRepository, PriceRateService, DueRepository, DueService],
})
export class PlatformBillingModule {}
