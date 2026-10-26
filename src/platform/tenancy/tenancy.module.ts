import { Global, Module } from '@nestjs/common';
import { TenantAccessGate } from '../../common/auth/tenant-access-gate.js';
import { InstitutionController } from './institution.controller.js';
import { InstitutionRepository } from './institution.repository.js';
import { InstitutionService } from './institution.service.js';
import { PlatformInstitutionController } from './platform-institution.controller.js';
import { SocietyController } from './society.controller.js';
import { SocietyRepository } from './society.repository.js';
import { SocietyService } from './society.service.js';
import { ScopeService } from './scope.service.js';
import { TenancyAccessGate } from './tenancy-access-gate.js';
import { TenancyRepository } from './tenancy.repository.js';

/** Global so the policy guard in the common module finds the real pause check. */
@Global()
@Module({
  controllers: [SocietyController, InstitutionController, PlatformInstitutionController],
  providers: [
    TenancyRepository,
    SocietyRepository,
    SocietyService,
    InstitutionRepository,
    InstitutionService,
    ScopeService,
    { provide: TenantAccessGate, useClass: TenancyAccessGate },
  ],
  exports: [ScopeService, TenantAccessGate],
})
export class TenancyModule {}
