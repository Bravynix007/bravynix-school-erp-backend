import { Module } from '@nestjs/common';
import { AcademicSetupModule } from '../academic-setup/index.js';
import { TimeSlotController } from './time-slot.controller.js';
import { TimeSlotRepository } from './time-slot.repository.js';
import { TimeSlotService } from './time-slot.service.js';

/** The school's timetable (PRD 7.8): the period timings of each academic year. */
@Module({
  imports: [AcademicSetupModule],
  controllers: [TimeSlotController],
  providers: [TimeSlotRepository, TimeSlotService],
})
export class TimetableModule {}
