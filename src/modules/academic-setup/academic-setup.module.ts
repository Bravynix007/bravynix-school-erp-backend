import { Module } from '@nestjs/common';
import { MastersModule } from '../../platform/masters/index.js';
import { AcademicYearController } from './academic-year.controller.js';
import { AcademicYearRepository } from './academic-year.repository.js';
import { AcademicYearService } from './academic-year.service.js';
import { ClassController, SectionController } from './class.controller.js';
import { ClassRepository } from './class.repository.js';
import { ClassService } from './class.service.js';
import { SectionRepository } from './section.repository.js';
import { SectionService } from './section.service.js';
import { SubjectDirectory } from './subject-directory.js';
import { SubjectController } from './subject.controller.js';
import { SubjectRepository } from './subject.repository.js';
import { SubjectService } from './subject.service.js';

/** Academic setup (PRD 7.2 to 7.4): the years, classes, sections and subjects of an Institution or Society. */
@Module({
  imports: [MastersModule],
  controllers: [AcademicYearController, SubjectController, ClassController, SectionController],
  providers: [
    AcademicYearRepository,
    AcademicYearService,
    SubjectRepository,
    SubjectService,
    SubjectDirectory,
    ClassRepository,
    ClassService,
    SectionRepository,
    SectionService,
  ],
  exports: [SubjectDirectory],
})
export class AcademicSetupModule {}
