import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import {
  CreateExamPaperDto,
  ListExamPapersQueryDto,
  UpdateExamPaperDto,
} from './exam-paper.dto.js';
import type { ExamPaperResource } from './exam-paper.resource.js';
import { ExamPaperService } from './exam-paper.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** EXM-05 to EXM-08 (API design 9.8): the papers of an exam, its datesheet (PRD 7.11 step 2). */
@ApiTags('Exams')
@Controller()
export class ExamPaperController {
  constructor(private readonly papers: ExamPaperService) {}

  @Policy({
    roles: [...WRITERS, RoleCode.TeacherStaff, RoleCode.StudentParent],
    scope: 'institution',
    operationId: 'EXM-05',
    rule: 'The active papers of an exam in the order they are sat, one section’s with `sectionId`; a parent names their own child with `studentId` and reads that child’s section once the datesheet is published (none before; 404 for any other child, 403 CHILD_ACCESS_BLOCKED for a blocked one), without the teacher and the invigilator',
  })
  @Get('exams/:examId/papers')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('examId', UuidParamPipe) examId: string,
    @Query() query: ListExamPapersQueryDto,
  ): Promise<ApiResult<ExamPaperResource[]>> {
    return this.papers.list(principal, examId, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'EXM-06',
    rule: 'Adds a paper of an active exam for an active section and subject: a day the exam runs, an end after the start, passing marks within the maximum (400 OUT_OF_RANGE), a teacher of the Institution who teaches the subject and an invigilator of the Institution when named, 409 DUPLICATE (the section’s paper for that subject), PAPER_OVERLAP (the section), INVIGILATOR_DOUBLE_BOOKED, ROOM_TAKEN',
  })
  @Post('exams/:examId/papers')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Param('examId', UuidParamPipe) examId: string,
    @Body() body: CreateExamPaperDto,
  ): Promise<ApiResult<ExamPaperResource>> {
    return ApiResult.created(await this.papers.create(principal, examId, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'EXM-07',
    rule: 'Changes an active paper’s day, times, room, marks, teacher or invigilator; versioned; the same refusals as EXM-06 on what changes',
  })
  @Patch('exam-papers/:paperId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('paperId', UuidParamPipe) paperId: string,
    @Body() body: UpdateExamPaperDto,
  ): Promise<ExamPaperResource> {
    return this.papers.update(principal, paperId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'EXM-08',
    rule: 'Deactivates an active paper; its section, time and room are free again; nothing is deleted',
  })
  @Delete('exam-papers/:paperId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('paperId', UuidParamPipe) paperId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.papers.deactivate(principal, paperId);
  }
}
