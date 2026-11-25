import { Module } from '@nestjs/common';
import { AcademicSetupModule } from '../academic-setup/index.js';
import { ExamController } from './exam.controller.js';
import { ExamRepository } from './exam.repository.js';
import { ExamService } from './exam.service.js';
import { GradeBandController } from './grade-band.controller.js';
import { GradeBandRepository } from './grade-band.repository.js';
import { GradeBandService } from './grade-band.service.js';

/** Exams and results (PRD 7.11): the grade bands of each Institution, and its exams. */
@Module({
  imports: [AcademicSetupModule],
  controllers: [GradeBandController, ExamController],
  providers: [GradeBandRepository, GradeBandService, ExamRepository, ExamService],
})
export class ExamsModule {}
