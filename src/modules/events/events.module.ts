import { Module } from '@nestjs/common';
import { AcademicSetupModule } from '../academic-setup/index.js';
import { MastersModule } from '../../platform/masters/index.js';
import { EventController } from './event.controller.js';
import { EventRepository } from './event.repository.js';
import { EventService } from './event.service.js';

/** Events and holidays (PRD 7.12): the calendar of a Society and its Institutions. */
@Module({
  imports: [MastersModule, AcademicSetupModule],
  controllers: [EventController],
  providers: [EventRepository, EventService],
})
export class EventsModule {}
