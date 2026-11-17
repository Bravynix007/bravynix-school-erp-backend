import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { CalendarDateParamPipe } from '../../common/http/calendar-date-param.pipe.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CalendarQueryDto } from './student-calendar.dto.js';
import type { StudentCalendarResource, StudentDayResource } from './student-calendar.resource.js';
import { StudentCalendarService } from './student-calendar.service.js';

const READERS = [
  RoleCode.SocietyOwner,
  RoleCode.InstitutionAdmin,
  RoleCode.TeacherStaff,
  RoleCode.StudentParent,
];

/** ATT-07 and ATT-08 (API design 10.13): a student's attendance as a calendar and a day. */
@ApiTags('Attendance')
@Controller('students/:studentId/attendance')
export class StudentCalendarController {
  constructor(private readonly calendar: StudentCalendarService) {}

  @Policy({
    roles: READERS,
    scope: 'institution',
    operationId: 'ATT-07',
    rule: 'A month of one student: each day present, absent, late, half day, leave, holiday, not marked or not enrolled, the counts of the month and the share attended this year to date; an Owner or Admin of the Institution, a teacher or staff member for a student of their own sections this year (403 NOT_ASSIGNED), a parent for their own child only (404 for another, 403 CHILD_ACCESS_BLOCKED when blocked); 422 OUTSIDE_ACADEMIC_YEAR',
  })
  @Get()
  month(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Query() query: CalendarQueryDto,
  ): Promise<StudentCalendarResource> {
    return this.calendar.month(principal, studentId, query);
  }

  @Policy({
    roles: READERS,
    scope: 'institution',
    operationId: 'ATT-08',
    rule: 'One day of one student: the status, the section the student sat in, who marked it and when, and any correction; read by the same people as ATT-07; 400 INVALID_FORMAT for a date that is not a real day; 422 OUTSIDE_ACADEMIC_YEAR',
  })
  @Get('days/:date')
  day(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Param('date', CalendarDateParamPipe) date: string,
  ): Promise<StudentDayResource> {
    return this.calendar.day(principal, studentId, date);
  }
}
