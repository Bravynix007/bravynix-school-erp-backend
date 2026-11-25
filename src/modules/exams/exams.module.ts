import { Module } from '@nestjs/common';
import { AcademicSetupModule } from '../academic-setup/index.js';
import { ExamPaperController } from './exam-paper.controller.js';
import { ExamPaperRepository } from './exam-paper.repository.js';
import { ExamPaperService } from './exam-paper.service.js';
import { ExamController } from './exam.controller.js';
import { ExamRepository } from './exam.repository.js';
import { ExamService } from './exam.service.js';
import { GradeBandController } from './grade-band.controller.js';
import { GradeBandRepository } from './grade-band.repository.js';
import { GradeBandService } from './grade-band.service.js';

/** Exams and results (PRD 7.11): the grade bands of each Institution, its exams and their papers. */
@Module({
  imports: [AcademicSetupModule],
  controllers: [GradeBandController, ExamController, ExamPaperController],
  providers: [
    GradeBandRepository,
    GradeBandService,
    ExamRepository,
    ExamService,
    ExamPaperRepository,
    ExamPaperService,
  ],
})
export class ExamsModule {}
