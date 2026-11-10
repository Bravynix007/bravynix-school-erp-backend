import { Global, Module } from '@nestjs/common';
import { AcademicSetupModule, TeachingStaff } from '../academic-setup/index.js';
import { FilesModule } from '../../platform/files/index.js';
import { MastersModule } from '../../platform/masters/index.js';
import { AssignmentRepository } from './assignment.repository.js';
import { AssignmentService } from './assignment.service.js';
import { DocumentController } from './document.controller.js';
import { DocumentRepository } from './document.repository.js';
import { DocumentService } from './document.service.js';
import { IdentityRepository } from './identity.repository.js';
import { InstitutionAdminController } from './institution-admin.controller.js';
import { InstitutionAdminService } from './institution-admin.service.js';
import { PeopleTeachingStaff } from './people-teaching-staff.js';
import { StaffDocumentController } from './staff-document.controller.js';
import { StaffIdentityController } from './staff-identity.controller.js';
import { StaffIdentityService } from './staff-identity.service.js';
import { StaffContext } from './staff-context.js';
import { StaffController } from './staff.controller.js';
import { StaffRepository } from './staff.repository.js';
import { StaffService } from './staff.service.js';
import { TeachingAssignmentController } from './teaching-assignment.controller.js';

/**
 * People (PRD 7.5, 7.6): the staff of a Society, and later its students and their guardians. Global so that Academic
 * setup, which may not import People (SDD 9.3), finds what it asks of it (`TeachingStaff`).
 */
@Global()
@Module({
  imports: [MastersModule, FilesModule, AcademicSetupModule],
  controllers: [
    StaffController,
    StaffIdentityController,
    StaffDocumentController,
    DocumentController,
    InstitutionAdminController,
    TeachingAssignmentController,
  ],
  providers: [
    StaffRepository,
    StaffContext,
    StaffService,
    InstitutionAdminService,
    AssignmentRepository,
    AssignmentService,
    IdentityRepository,
    StaffIdentityService,
    DocumentRepository,
    DocumentService,
    PeopleTeachingStaff,
    { provide: TeachingStaff, useExisting: PeopleTeachingStaff },
  ],
  exports: [TeachingStaff],
})
export class PeopleModule {}
