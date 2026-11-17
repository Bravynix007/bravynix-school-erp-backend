import { Global, Module } from '@nestjs/common';
import { ChildContexts } from '../../platform/tenancy/index.js';
import { AttendanceStaff, SectionRoster } from '../attendance/index.js';
import { EventPeople } from '../events/index.js';
import { TimetableChildren, TimetableStaff } from '../timetable/index.js';
import { AcademicSetupModule, SectionStudents, TeachingStaff } from '../academic-setup/index.js';
import { FileReaders, FilesModule } from '../../platform/files/index.js';
import { IdempotencyModule } from '../../platform/idempotency/index.js';
import { JobsModule } from '../../platform/jobs/index.js';
import { MastersModule } from '../../platform/masters/index.js';
import { AchievementController } from './achievement.controller.js';
import { AchievementRepository } from './achievement.repository.js';
import { AchievementService } from './achievement.service.js';
import { PromotionController } from './promotion.controller.js';
import { PromotionService } from './promotion.service.js';
import { AssignmentRepository } from './assignment.repository.js';
import { AssignmentService } from './assignment.service.js';
import { DocumentController } from './document.controller.js';
import { DocumentRepository } from './document.repository.js';
import { DocumentService } from './document.service.js';
import { GuardianContext } from './guardian-context.js';
import { ImportController } from './import.controller.js';
import { ImportProcessor } from './import.processor.js';
import { ImportRepository } from './import.repository.js';
import { ImportService } from './import.service.js';
import { GuardianController } from './guardian.controller.js';
import { GuardianRepository } from './guardian.repository.js';
import { GuardianService } from './guardian.service.js';
import { IdentityRepository } from './identity.repository.js';
import { InstitutionAdminController } from './institution-admin.controller.js';
import { InstitutionAdminService } from './institution-admin.service.js';
import { PeopleChildContexts } from './people-child-contexts.js';
import { PeopleEventPeople } from './people-event-people.js';
import { PeopleFileReaders } from './people-file-readers.js';
import { PeopleTimetableChildren } from './people-timetable-children.js';
import { PeopleAttendanceStaff } from './people-attendance-staff.js';
import { PeopleSectionRoster } from './people-section-roster.js';
import { PeopleTimetableStaff } from './people-timetable-staff.js';
import { PeopleSectionStudents } from './people-section-students.js';
import { PeopleTeachingStaff } from './people-teaching-staff.js';
import { StaffDocumentController } from './staff-document.controller.js';
import { StudentDocumentController } from './student-document.controller.js';
import { StaffIdentityController } from './staff-identity.controller.js';
import { StaffIdentityService } from './staff-identity.service.js';
import { StaffContext } from './staff-context.js';
import { StaffController } from './staff.controller.js';
import { StaffRepository } from './staff.repository.js';
import { StaffService } from './staff.service.js';
import { StudentClassroomService } from './student-classroom.service.js';
import { ChildAccess } from './child-access.js';
import { StudentContext } from './student-context.js';
import { StudentIdentityController } from './student-identity.controller.js';
import { StudentIdentityRepository } from './student-identity.repository.js';
import { StudentIdentityService } from './student-identity.service.js';
import { StudentController } from './student.controller.js';
import { StudentRepository } from './student.repository.js';
import { StudentService } from './student.service.js';
import { TeachingAssignmentController } from './teaching-assignment.controller.js';

/**
 * People (PRD 7.5, 7.6): the staff of a Society, and later its students and their guardians. Global so that Academic
 * setup and Files, which may not import People (SDD 9.3), find what they ask of it (`TeachingStaff`, `SectionStudents`, `FileReaders`).
 */
@Global()
@Module({
  imports: [MastersModule, FilesModule, AcademicSetupModule, IdempotencyModule, JobsModule],
  controllers: [
    StaffController,
    StaffIdentityController,
    StaffDocumentController,
    StudentDocumentController,
    DocumentController,
    InstitutionAdminController,
    TeachingAssignmentController,
    StudentController,
    StudentIdentityController,
    GuardianController,
    AchievementController,
    PromotionController,
    ImportController,
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
    AchievementRepository,
    AchievementService,
    PromotionService,
    ImportRepository,
    ImportService,
    ImportProcessor,
    StudentRepository,
    ChildAccess,
    StudentContext,
    StudentService,
    StudentClassroomService,
    StudentIdentityRepository,
    StudentIdentityService,
    GuardianRepository,
    GuardianContext,
    GuardianService,
    PeopleTeachingStaff,
    { provide: TeachingStaff, useExisting: PeopleTeachingStaff },
    PeopleSectionStudents,
    { provide: SectionStudents, useExisting: PeopleSectionStudents },
    PeopleFileReaders,
    { provide: FileReaders, useExisting: PeopleFileReaders },
    PeopleEventPeople,
    { provide: EventPeople, useExisting: PeopleEventPeople },
    PeopleChildContexts,
    { provide: ChildContexts, useExisting: PeopleChildContexts },
    PeopleTimetableChildren,
    { provide: TimetableChildren, useExisting: PeopleTimetableChildren },
    PeopleTimetableStaff,
    { provide: TimetableStaff, useExisting: PeopleTimetableStaff },
    PeopleSectionRoster,
    { provide: SectionRoster, useExisting: PeopleSectionRoster },
    PeopleAttendanceStaff,
    { provide: AttendanceStaff, useExisting: PeopleAttendanceStaff },
  ],
  exports: [
    TeachingStaff,
    SectionStudents,
    FileReaders,
    EventPeople,
    ChildContexts,
    TimetableChildren,
    TimetableStaff,
    SectionRoster,
    AttendanceStaff,
  ],
})
export class PeopleModule {}
