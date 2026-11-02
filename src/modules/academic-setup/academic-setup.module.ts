import { Module } from '@nestjs/common';
import { AcademicYearController } from './academic-year.controller.js';
import { AcademicYearRepository } from './academic-year.repository.js';
import { AcademicYearService } from './academic-year.service.js';

/** Academic setup (PRD 7.2 to 7.4): the years, classes, sections and subjects of an Institution or Society. */
@Module({
  controllers: [AcademicYearController],
  providers: [AcademicYearRepository, AcademicYearService],
})
export class AcademicSetupModule {}
