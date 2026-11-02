import { Global, Module } from '@nestjs/common';
import { IdempotencyModule } from '../../platform/idempotency/index.js';
import { NumberingModule } from '../../platform/numbering/index.js';
import { SocietyDues } from '../../platform/tenancy/index.js';
import { DueFigures } from './due-figures.js';
import { DueRepository } from './due.repository.js';
import { DueService } from './due.service.js';
import { OwnerDueController } from './owner-due.controller.js';
import { OwnerDueService } from './owner-due.service.js';
import { PlatformDueController } from './platform-due.controller.js';
import { PlatformPriceRateController } from './platform-price-rate.controller.js';
import { PriceRateRepository } from './price-rate.repository.js';
import { PriceRateService } from './price-rate.service.js';

/**
 * Platform billing (PRD 9.2, 9.3): what BravyNix charges each Institution. Rates and dues, and the Owner's view of them.
 * Global so that Tenancy, which may not import a business module, finds what it asks of billing (`SocietyDues`).
 */
@Global()
@Module({
  imports: [IdempotencyModule, NumberingModule],
  controllers: [PlatformPriceRateController, PlatformDueController, OwnerDueController],
  providers: [
    PriceRateRepository,
    PriceRateService,
    DueRepository,
    DueService,
    OwnerDueService,
    DueFigures,
    { provide: SocietyDues, useExisting: DueFigures },
  ],
  exports: [DueFigures, SocietyDues],
})
export class PlatformBillingModule {}
