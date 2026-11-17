import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/index.js';
import { NotificationsController, PushDeviceController } from './notifications.controller.js';
import { Notifications } from './notifications.port.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';
import { NotifyProcessor } from './notify.processor.js';
import { LogPushSender, PushSender } from './push-sender.js';

/**
 * Notifications (SDD 9.3, API design 9.1): a person's inbox, the push token of their phone, and the worker that
 * writes a notice to its receivers and sends the push. Other modules ask through `Notifications`.
 */
@Module({
  imports: [JobsModule],
  providers: [
    NotificationsRepository,
    NotificationsService,
    Notifications,
    NotifyProcessor,
    { provide: PushSender, useClass: LogPushSender },
  ],
  controllers: [NotificationsController, PushDeviceController],
  exports: [Notifications],
})
export class NotificationsModule {}
