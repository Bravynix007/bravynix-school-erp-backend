import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../platform/idempotency/index.js';
import { NotificationsModule } from '../../platform/notifications/index.js';
import { AcademicSetupModule } from '../academic-setup/index.js';
import { EventsModule } from '../events/index.js';
import { AttendanceRegisters } from './attendance-registers.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceRepository } from './attendance.repository.js';
import { AttendanceService } from './attendance.service.js';
import { StudentCalendarController } from './student-calendar.controller.js';
import { StudentCalendarService } from './student-calendar.service.js';

/** Attendance (PRD 7.7): a section's attendance once a day, and who was not Present. */
@Module({
  imports: [AcademicSetupModule, EventsModule, IdempotencyModule, NotificationsModule],
  controllers: [AttendanceController, StudentCalendarController],
  providers: [AttendanceRepository, AttendanceService, StudentCalendarService, AttendanceRegisters],
  exports: [AttendanceRegisters],
})
export class AttendanceModule {}
