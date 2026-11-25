import { Module } from '@nestjs/common';
import { GradeBandController } from './grade-band.controller.js';
import { GradeBandRepository } from './grade-band.repository.js';
import { GradeBandService } from './grade-band.service.js';

/** Exams and results (PRD 7.11): the grade bands of each Institution. */
@Module({
  controllers: [GradeBandController],
  providers: [GradeBandRepository, GradeBandService],
})
export class ExamsModule {}
