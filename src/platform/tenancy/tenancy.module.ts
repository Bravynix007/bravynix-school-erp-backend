import { Global, Module } from '@nestjs/common';
import { TenantAccessGate } from '../../common/auth/tenant-access-gate.js';
import { ScopeService } from './scope.service.js';
import { TenancyAccessGate } from './tenancy-access-gate.js';
import { TenancyRepository } from './tenancy.repository.js';

/** Global so the policy guard in the common module finds the real pause check. */
@Global()
@Module({
  providers: [
    TenancyRepository,
    ScopeService,
    { provide: TenantAccessGate, useClass: TenancyAccessGate },
  ],
  exports: [ScopeService, TenantAccessGate],
})
export class TenancyModule {}
