import { Module } from '@nestjs/common';
import { AcademicSetupModule } from '../academic-setup/index.js';
import { TimeSlotController } from './time-slot.controller.js';
import { TimeSlotRepository } from './time-slot.repository.js';
import { TimeSlotService } from './time-slot.service.js';
import { TimetableEntryController } from './timetable-entry.controller.js';
import { TimetableEntryRepository } from './timetable-entry.repository.js';
import { TimetableEntryService } from './timetable-entry.service.js';

/** The school's timetable (PRD 7.8): the period timings of each academic year and the weekly class timetable. */
@Module({
  imports: [AcademicSetupModule],
  controllers: [TimeSlotController, TimetableEntryController],
  providers: [TimeSlotRepository, TimeSlotService, TimetableEntryRepository, TimetableEntryService],
})
export class TimetableModule {}
