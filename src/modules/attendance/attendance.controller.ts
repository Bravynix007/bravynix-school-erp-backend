import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { VersionedStatedReasonDto } from '../../common/validation/reason.dto.js';
import { IDEMPOTENCY_HEADER } from '../../platform/idempotency/index.js';
import {
  CorrectAttendanceDto,
  ListSessionsQueryDto,
  RosterQueryDto,
  SubmitAttendanceDto,
} from './attendance.dto.js';
import type {
  AttendanceSessionDetailResource,
  AttendanceSessionResource,
  RosterResource,
} from './attendance.resource.js';
import { AttendanceService } from './attendance.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];
const MARKERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin, RoleCode.TeacherStaff];

/** ATT-01 to ATT-06 (API design 9.7, 10.10 to 10.12): taking a section's attendance once a day. */
@ApiTags('Attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Policy({
    roles: MARKERS,
    scope: 'institution',
    operationId: 'ATT-01',
    rule: 'The students placed in a section on a date, by roll number, each Present until a session says otherwise, with the holiday of the day, the session already submitted and whether the caller may mark now (an Owner or Admin of the Institution, a teacher or staff member of its home); 404 for a section out of reach',
  })
  @Get('roster')
  roster(
    @CurrentPrincipal() principal: Principal,
    @Query() query: RosterQueryDto,
  ): Promise<RosterResource> {
    return this.attendance.rosterOf(principal, query);
  }

  @Policy({
    roles: MARKERS,
    scope: 'institution',
    operationId: 'ATT-02',
    rule: 'Submits the attendance of a section for a day, once: the students who are not Present, in one transaction with the counts, the audit and an alert to the parents of each absent student; a teacher or staff member only at their home Institution (403 NOT_ASSIGNED); 422 DATE_IN_FUTURE, DATE_OUTSIDE_CURRENT_YEAR, DATE_IS_HOLIDAY, STUDENT_NOT_IN_SECTION; 409 ATTENDANCE_ALREADY_SUBMITTED, ROSTER_CHANGED',
  })
  @ApiHeader({ name: IDEMPOTENCY_HEADER, required: true, description: 'A UUID; a retry reuses it' })
  @Post('sessions')
  submit(
    @CurrentPrincipal() principal: Principal,
    @Headers(IDEMPOTENCY_HEADER) key: string | string[] | undefined,
    @Body() body: SubmitAttendanceDto,
  ): Promise<ApiResult<AttendanceSessionResource>> {
    return this.attendance.submit(principal, key, body);
  }

  @Policy({
    roles: MARKERS,
    scope: 'institution',
    operationId: 'ATT-03',
    rule: 'The sessions of a section, or of every section of an Institution, on a date, in the order they were submitted',
  })
  @Get('sessions')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListSessionsQueryDto,
  ): Promise<ApiResult<AttendanceSessionResource[]>> {
    return this.attendance.list(principal, query);
  }

  @Policy({
    roles: MARKERS,
    scope: 'institution',
    operationId: 'ATT-04',
    rule: 'One session with the students who were not Present; 404 for a session out of reach or voided',
  })
  @Get('sessions/:sessionId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId', UuidParamPipe) sessionId: string,
  ): Promise<AttendanceSessionDetailResource> {
    return this.attendance.get(principal, sessionId);
  }

  @Policy({
    roles: MARKERS,
    scope: 'institution',
    operationId: 'ATT-05',
    rule: 'Changes the marks of a submitted session, 1 Present included (it takes the exception away); versioned (409 VERSION_CONFLICT first, then SESSION_VOIDED); the counts follow in the same transaction, each student is audited with before and after, and a student now Absent who was not is alerted; a teacher or staff member only at their home Institution (403 NOT_ASSIGNED) and only in the current year (403 FORBIDDEN); 422 STUDENT_NOT_IN_SECTION',
  })
  @Patch('sessions/:sessionId/marks')
  correct(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId', UuidParamPipe) sessionId: string,
    @Body() body: CorrectAttendanceDto,
  ): Promise<AttendanceSessionResource> {
    return this.attendance.correct(principal, sessionId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'ATT-06',
    rule: 'Voids a session submitted by mistake, with a reason (kept in the audit); versioned; the day is free for a new submission; 409 VERSION_CONFLICT, 409 SESSION_VOIDED for one already void',
  })
  @Post('sessions/:sessionId/void')
  voidSession(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId', UuidParamPipe) sessionId: string,
    @Body() body: VersionedStatedReasonDto,
  ): Promise<{ id: string; status: 0 }> {
    return this.attendance.voidSession(principal, sessionId, body);
  }
}
