import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import {
  CreateTimetableEntryDto,
  ListTimetableQueryDto,
  UpdateTimetableEntryDto,
} from './timetable-entry.dto.js';
import type { TimetableEntryResource } from './timetable-entry.resource.js';
import { TimetableEntryService } from './timetable-entry.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** TT-01 to TT-04 (API design 9.7): the weekly class timetable of an Institution's current year. */
@ApiTags('Timetable')
@Controller('timetable/entries')
export class TimetableEntryController {
  constructor(private readonly entries: TimetableEntryService) {}

  @Policy({
    roles: [...WRITERS, RoleCode.TeacherStaff, RoleCode.StudentParent],
    scope: 'institution',
    operationId: 'TT-01',
    rule: 'The active entries of one week of the Institution’s current year (422 CURRENT_YEAR_REQUIRED when it has none), by day and period: a section’s (`sectionId`), a teacher’s own at an Institution (`staffMemberId` is `me` or their ID, with `institutionId`), or a parent’s own child’s section (`studentId`: 404 for any other child, 403 CHILD_ACCESS_BLOCKED for a blocked one); a teacher reads only the sections they lead or teach (403 NOT_ASSIGNED) and their own week',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListTimetableQueryDto,
  ): Promise<ApiResult<TimetableEntryResource[]>> {
    return this.entries.list(principal, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'TT-02',
    rule: 'Adds a lesson or a break to a section’s day (Monday to Saturday) and period of the Institution’s current year, with the clash rules of API design 12.6 in their order: INVALID_SLOT, REQUIRED and FIELD_NOT_ALLOWED on the subject and the teacher, an active subject and a teacher of this Institution who teaches it, 409 SECTION_SLOT_TAKEN, 409 TEACHER_DOUBLE_BOOKED',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateTimetableEntryDto,
  ): Promise<ApiResult<TimetableEntryResource>> {
    return ApiResult.created(await this.entries.create(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'TT-03',
    rule: 'Changes the day, the period, the break flag, the subject or the teacher of an entry; versioned; the same clash rules as TT-02; making it a break clears the subject and the teacher',
  })
  @Patch(':entryId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('entryId', UuidParamPipe) entryId: string,
    @Body() body: UpdateTimetableEntryDto,
  ): Promise<TimetableEntryResource> {
    return this.entries.update(principal, entryId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'TT-04',
    rule: 'Removes an entry: its day and period are free again; nothing is deleted',
  })
  @Delete(':entryId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('entryId', UuidParamPipe) entryId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.entries.deactivate(principal, entryId);
  }
}
