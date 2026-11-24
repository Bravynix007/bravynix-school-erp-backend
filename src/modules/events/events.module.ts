import { Module } from '@nestjs/common';
import { AcademicSetupModule } from '../academic-setup/index.js';
import { NotificationsModule } from '../../platform/notifications/index.js';
import { FilesModule } from '../../platform/files/index.js';
import { MastersModule } from '../../platform/masters/index.js';
import { EventController } from './event.controller.js';
import { EventRepository } from './event.repository.js';
import { EventService } from './event.service.js';
import { HolidayCalendar } from './holiday-calendar.js';

/** Events and holidays (PRD 7.12): the calendar of a Society and its Institutions. */
@Module({
  imports: [FilesModule, MastersModule, AcademicSetupModule, NotificationsModule],
  controllers: [EventController],
  providers: [EventRepository, EventService, HolidayCalendar],
  exports: [HolidayCalendar],
})
export class EventsModule {}
