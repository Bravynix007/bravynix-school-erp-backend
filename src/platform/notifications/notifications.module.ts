import { Module } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app-config.js';
import { JobsModule } from '../jobs/index.js';
import { NotificationsController, PushDeviceController } from './notifications.controller.js';
import { Notifications } from './notifications.port.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';
import { NotifyProcessor } from './notify.processor.js';
import { PushSender } from './push-sender.js';
import { createPushSender } from './push-sender.factory.js';

/**
 * Notifications (SDD 9.3, API design 9.1): a person's inbox, the push token of their phone, and the worker that
 * writes a notice to its receivers and sends the push (the log driver, or Firebase when `PUSH_DRIVER` says so). Other modules ask through `Notifications`.
 */
@Module({
  imports: [JobsModule],
  providers: [
    NotificationsRepository,
    NotificationsService,
    Notifications,
    NotifyProcessor,
    {
      provide: PushSender,
      inject: [AppConfig, Clock],
      useFactory: ({ env }: AppConfig, clock: Clock): Promise<PushSender> =>
        createPushSender(env, clock),
    },
  ],
  controllers: [NotificationsController, PushDeviceController],
  exports: [Notifications],
})
export class NotificationsModule {}
