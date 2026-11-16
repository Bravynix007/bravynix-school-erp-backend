import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import {
  ChangeEventScopeDto,
  CreateEventDto,
  GetEventQueryDto,
  ListEventsQueryDto,
  UpdateEventDto,
} from './event.dto.js';
import type { EventResource } from './event.resource.js';
import { EventService } from './event.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** EVT-01 to EVT-06 (API design 9.10): the events and holidays of a Society and its Institutions. */
@ApiTags('Events')
@Controller('events')
export class EventController {
  constructor(private readonly events: EventService) {}

  @Policy({
    roles: [...WRITERS, RoleCode.TeacherStaff, RoleCode.StudentParent],
    scope: 'society',
    operationId: 'EVT-01',
    rule: 'The active events with a day in `from` to `to` (at most 366 days, 400 RANGE_TOO_LARGE) or in an academic year of an Institution, earliest first: the Society’s and the caller’s Institutions’ events, for the audiences the role is told about (teachers and staff: everyone and staff); `holidays` keeps holidays only; a parent names their own child with `studentId` (404 for any other, 403 CHILD_ACCESS_BLOCKED for a blocked one), reads dates only, and is told of events for everyone and for students and parents, and of holidays for students',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListEventsQueryDto,
  ): Promise<ApiResult<EventResource[]>> {
    return this.events.list(principal, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'EVT-02',
    rule: 'The Owner makes an event or holiday of either scope; an Admin only of an Institution they administer (403 SCOPE_NOT_ALLOWED for the Society’s); a holiday names its type and who it is for, and the classes it is limited to',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateEventDto,
  ): Promise<ApiResult<EventResource>> {
    return ApiResult.created(await this.events.create(principal, body));
  }

  @Policy({
    roles: [...WRITERS, RoleCode.TeacherStaff, RoleCode.StudentParent],
    scope: 'society',
    operationId: 'EVT-03',
    rule: 'One active event of the Society or an Institution the caller reaches, for an audience their role is told about; any other is 404; a parent names their own child with `studentId` and reads what that child’s Society and Institution hold for parents',
  })
  @Get(':eventId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('eventId', UuidParamPipe) eventId: string,
    @Query() query: GetEventQueryDto,
  ): Promise<EventResource> {
    return this.events.get(principal, eventId, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'EVT-04',
    rule: 'Edits an active event: the Owner any, an Admin only an Institution event of an Institution they administer (403 SCOPE_NOT_ALLOWED otherwise); versioned; marking it not a holiday clears the holiday fields',
  })
  @Patch(':eventId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('eventId', UuidParamPipe) eventId: string,
    @Body() body: UpdateEventDto,
  ): Promise<EventResource> {
    return this.events.update(principal, eventId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'EVT-05',
    rule: 'Deactivates an active event; as EVT-04 for who may; nothing is deleted',
  })
  @Delete(':eventId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('eventId', UuidParamPipe) eventId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.events.deactivate(principal, eventId);
  }

  @Policy({
    roles: [RoleCode.SocietyOwner],
    scope: 'society',
    operationId: 'EVT-06',
    rule: 'Moves an active event between the Society and one Institution the Owner reaches; versioned',
  })
  @Post(':eventId/scope')
  changeScope(
    @CurrentPrincipal() principal: Principal,
    @Param('eventId', UuidParamPipe) eventId: string,
    @Body() body: ChangeEventScopeDto,
  ): Promise<EventResource> {
    return this.events.changeScope(principal, eventId, body);
  }
}
