import { Global, Module } from '@nestjs/common';
import { TenantAccessGate } from '../../common/auth/tenant-access-gate.js';
import { TenancyAccessGate } from './tenancy-access-gate.js';
import { TenancyRepository } from './tenancy.repository.js';
import { TenancyService } from './tenancy.service.js';

/** Global so the policy guard in the common module finds the real pause check. */
@Global()
@Module({
  providers: [
    TenancyRepository,
    TenancyService,
    { provide: TenantAccessGate, useClass: TenancyAccessGate },
  ],
  exports: [TenancyService, TenantAccessGate],
})
export class TenancyModule {}
