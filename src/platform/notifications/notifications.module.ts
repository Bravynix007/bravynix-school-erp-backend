import { Module } from '@nestjs/common';
import { NotificationsController, PushDeviceController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

/** Notifications (SDD 9.3, API design 9.1): a person's inbox and the push token of their phone. */
@Module({
  providers: [NotificationsRepository, NotificationsService],
  controllers: [NotificationsController, PushDeviceController],
})
export class NotificationsModule {}
