import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateTimeSlotDto, ListTimeSlotsQueryDto, UpdateTimeSlotDto } from './time-slot.dto.js';
import type { TimeSlotResource } from './time-slot.resource.js';
import { TimeSlotService } from './time-slot.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** TTS-01 to TTS-04 (API design 9.4): the period timings of an Institution's academic year. */
@ApiTags('Timetable')
@Controller('timetable/time-slots')
export class TimeSlotController {
  constructor(private readonly slots: TimeSlotService) {}

  @Policy({
    roles: [...WRITERS, RoleCode.TeacherStaff, RoleCode.StudentParent],
    scope: 'institution',
    operationId: 'TTS-01',
    rule: 'The active periods of an Institution’s academic year, earliest first: the year named or its current year (422 CURRENT_YEAR_REQUIRED when it has none); a parent names their own child with `studentId` instead of the Institution and the year (404 for any other child, 403 CHILD_ACCESS_BLOCKED for a blocked one)',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListTimeSlotsQueryDto,
  ): Promise<ApiResult<TimeSlotResource[]>> {
    return this.slots.list(principal, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'TTS-02',
    rule: 'Adds a period to an active academic year of an Institution the caller administers, its current year when none is named (422 CURRENT_YEAR_REQUIRED); the number is 1 to 30 and unused (409 DUPLICATE), the end is after the start (400 OUT_OF_RANGE on endTime) and the period overlaps no other of the year (409 TIME_SLOT_OVERLAP)',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateTimeSlotDto,
  ): Promise<ApiResult<TimeSlotResource>> {
    return ApiResult.created(await this.slots.create(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'TTS-03',
    rule: 'Changes the label or the times of an active period; versioned; the same refusals as TTS-02',
  })
  @Patch(':timeSlotId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('timeSlotId', UuidParamPipe) timeSlotId: string,
    @Body() body: UpdateTimeSlotDto,
  ): Promise<TimeSlotResource> {
    return this.slots.update(principal, timeSlotId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'TTS-04',
    rule: 'Deactivates an active period; its number and times are free again; nothing is deleted',
  })
  @Delete(':timeSlotId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('timeSlotId', UuidParamPipe) timeSlotId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.slots.deactivate(principal, timeSlotId);
  }
}
