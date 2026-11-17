import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../platform/notifications/index.js';
import { AcademicSetupModule } from '../academic-setup/index.js';
import { DiaryController } from './diary.controller.js';
import { DiaryRepository } from './diary.repository.js';
import { DiaryService } from './diary.service.js';

/** The diary (PRD 7.9): the homework or note a teacher writes for a section and subject on a day. */
@Module({
  imports: [AcademicSetupModule, NotificationsModule],
  controllers: [DiaryController],
  providers: [DiaryRepository, DiaryService],
})
export class DiaryModule {}
