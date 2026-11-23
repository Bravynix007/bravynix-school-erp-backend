import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import type { SubjectResource } from '../academic-setup/index.js';
import {
  CreateDiaryEntryDto,
  ListDiaryQueryDto,
  ListDiarySubjectsQueryDto,
  UpdateDiaryEntryDto,
} from './diary.dto.js';
import type { DiaryEntryResource } from './diary.resource.js';
import { DiaryService } from './diary.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin, RoleCode.TeacherStaff];

/** DIA-01 to DIA-04 (API design 9.7, 10.14a): the diary of a section; DIA-05 the subjects it can be written for. */
@ApiTags('Diary')
@Controller()
export class DiaryController {
  constructor(private readonly diary: DiaryService) {}

  @Policy({
    roles: [...WRITERS, RoleCode.StudentParent],
    scope: 'institution',
    operationId: 'DIA-01',
    rule: 'The active entries of a section on a date, in the order they were written, not paged: a section of an Institution the caller reaches (`sectionId`, 404 otherwise; a teacher reads only a section they lead or teach, 403 NOT_ASSIGNED), or a parent’s own child’s section (`studentId`: 404 for any other child, 403 CHILD_ACCESS_BLOCKED for a blocked one)',
  })
  @Get('diary-entries')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListDiaryQueryDto,
  ): Promise<ApiResult<DiaryEntryResource[]>> {
    return this.diary.list(principal, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'DIA-02',
    rule: 'Adds a diary entry for a section and subject on a date and tells the section’s parents; an Owner or Admin for any section and subject of their Institutions, a teacher only at their home Institution for a section and subject they teach or any subject of the section they lead (403 NOT_ASSIGNED); 422 REFERENCE_INACTIVE, CURRENT_YEAR_REQUIRED, DATE_IN_FUTURE, DATE_TOO_OLD (more than 7 days back), DATE_OUTSIDE_CURRENT_YEAR',
  })
  @Post('diary-entries')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateDiaryEntryDto,
  ): Promise<ApiResult<DiaryEntryResource>> {
    return ApiResult.created(await this.diary.create(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'DIA-03',
    rule: 'Changes the subject, the date or the description of an entry; versioned; an Owner or Admin of the Institution, or the teacher who wrote it (403 NOT_ASSIGNED for another teacher), who may write the new subject; a new date follows the rules of DIA-02',
  })
  @Patch('diary-entries/:entryId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('entryId', UuidParamPipe) entryId: string,
    @Body() body: UpdateDiaryEntryDto,
  ): Promise<DiaryEntryResource> {
    return this.diary.update(principal, entryId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'DIA-04',
    rule: 'Removes an entry from the lists; nothing is deleted; an Owner or Admin of the Institution, or the teacher who wrote it (403 NOT_ASSIGNED for another teacher)',
  })
  @Delete('diary-entries/:entryId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('entryId', UuidParamPipe) entryId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.diary.deactivate(principal, entryId);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'DIA-05',
    rule: 'The active subjects the caller may write the diary for in a section (`sectionId`, 404 for one out of reach), the same rule as DIA-02: an Owner or Admin every subject of the Society, a teacher at their home Institution every subject when they lead the section, else the subjects they teach in it (403 NOT_ASSIGNED when they do neither); 422 CURRENT_YEAR_REQUIRED',
  })
  @Get('diary-subjects')
  writableSubjects(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListDiarySubjectsQueryDto,
  ): Promise<ApiResult<SubjectResource[]>> {
    return this.diary.writableSubjects(principal, query);
  }
}
