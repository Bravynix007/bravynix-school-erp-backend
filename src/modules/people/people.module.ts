import { Module } from '@nestjs/common';
import { AcademicSetupModule } from '../academic-setup/index.js';
import { FilesModule } from '../../platform/files/index.js';
import { MastersModule } from '../../platform/masters/index.js';
import { AssignmentRepository } from './assignment.repository.js';
import { AssignmentService } from './assignment.service.js';
import { InstitutionAdminController } from './institution-admin.controller.js';
import { InstitutionAdminService } from './institution-admin.service.js';
import { StaffContext } from './staff-context.js';
import { StaffController } from './staff.controller.js';
import { StaffRepository } from './staff.repository.js';
import { StaffService } from './staff.service.js';
import { TeachingAssignmentController } from './teaching-assignment.controller.js';

/** People (PRD 7.5, 7.6): the staff of a Society, and later its students and their guardians. */
@Module({
  imports: [MastersModule, FilesModule, AcademicSetupModule],
  controllers: [StaffController, InstitutionAdminController, TeachingAssignmentController],
  providers: [
    StaffRepository,
    StaffContext,
    StaffService,
    InstitutionAdminService,
    AssignmentRepository,
    AssignmentService,
  ],
})
export class PeopleModule {}
