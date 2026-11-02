import { Module } from '@nestjs/common';
import { MasterReferences } from './master-references.js';
import { MasterController } from './master.controller.js';
import { MasterRepository } from './master.repository.js';
import { MasterService } from './master.service.js';
import { PlatformMasterController } from './platform-master.controller.js';

/** The platform masters (DDD 9.2): lists every Institution picks from, kept by Super Admin. */
@Module({
  controllers: [MasterController, PlatformMasterController],
  providers: [MasterRepository, MasterReferences, MasterService],
  exports: [MasterReferences],
})
export class MastersModule {}
