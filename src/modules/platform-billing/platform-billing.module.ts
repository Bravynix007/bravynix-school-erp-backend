import { Module } from '@nestjs/common';
import { PlatformPriceRateController } from './platform-price-rate.controller.js';
import { PriceRateRepository } from './price-rate.repository.js';
import { PriceRateService } from './price-rate.service.js';

/** Platform billing (PRD 9.2, 9.3): what BravyNix charges each Institution. Rates here; dues follow. */
@Module({
  controllers: [PlatformPriceRateController],
  providers: [PriceRateRepository, PriceRateService],
})
export class PlatformBillingModule {}
