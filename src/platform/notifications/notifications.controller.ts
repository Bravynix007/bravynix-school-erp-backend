import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { ListNotificationsQueryDto, PushDeviceDto, TabQueryDto } from './notifications.dto.js';
import { NotificationsService } from './notifications.service.js';
import type { NotificationResource } from './notifications.resource.js';

/** The people who have a phone: Owners, Admins, Teachers and Staff, and parents. A Super Admin has no inbox. */
const MOBILE_ROLES = [
  RoleCode.SocietyOwner,
  RoleCode.InstitutionAdmin,
  RoleCode.TeacherStaff,
  RoleCode.StudentParent,
];

/** NTF-01 to NTF-05 (API design 9.1): the caller's own inbox; a section block does not stop it (API design 6.5). */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Policy({
    roles: MOBILE_ROLES,
    scope: 'self',
    allowWhenBlocked: true,
    operationId: 'NTF-01',
    rule: 'The caller’s own notices of one tab, newest first, by cursor',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<ApiResult<NotificationResource[]>> {
    return this.notifications.list(principal, query);
  }

  @Policy({
    roles: MOBILE_ROLES,
    scope: 'self',
    allowWhenBlocked: true,
    operationId: 'NTF-02',
    rule: 'How many of the caller’s own notices are unread, 10 at most',
  })
  @Get('unread-count')
  unreadCount(@CurrentPrincipal() principal: Principal): Promise<{ count: number }> {
    return this.notifications.unreadCount(principal);
  }

  @Policy({
    roles: MOBILE_ROLES,
    scope: 'self',
    allowWhenBlocked: true,
    operationId: 'NTF-04',
    rule: 'Marks every unread notice of the caller read, of one tab when it is named',
  })
  @Post('read-all')
  markAllRead(
    @CurrentPrincipal() principal: Principal,
    @Query() query: TabQueryDto,
  ): Promise<{ updated: number }> {
    return this.notifications.markAllRead(principal, query.tab);
  }

  @Policy({
    roles: MOBILE_ROLES,
    scope: 'self',
    allowWhenBlocked: true,
    operationId: 'NTF-03',
    rule: 'Marks one of the caller’s own notices read; another person’s notice is 404',
  })
  @Post(':notificationId/read')
  markRead(
    @CurrentPrincipal() principal: Principal,
    @Param('notificationId', UuidParamPipe) notificationId: string,
  ): Promise<NotificationResource> {
    return this.notifications.markRead(principal, notificationId);
  }

  @Policy({
    roles: MOBILE_ROLES,
    scope: 'self',
    allowWhenBlocked: true,
    operationId: 'NTF-05',
    rule: 'Deletes the caller’s own notices, of one tab when it is named; nobody else’s',
  })
  @Delete()
  clear(
    @CurrentPrincipal() principal: Principal,
    @Query() query: TabQueryDto,
  ): Promise<{ deleted: number }> {
    return this.notifications.clear(principal, query.tab);
  }
}

/** ME-04 (API design 9.1): the push token of the caller's phone. */
@ApiTags('Me')
@Controller('me')
export class PushDeviceController {
  constructor(private readonly notifications: NotificationsService) {}

  @Policy({
    roles: MOBILE_ROLES,
    scope: 'self',
    allowNoContext: true,
    allowWhenBlocked: true,
    operationId: 'ME-04',
    rule: 'Registers or refreshes this session’s push token; the token moves to this session from any other',
  })
  @Put('push-device')
  async register(
    @CurrentPrincipal() principal: Principal,
    @Body() body: PushDeviceDto,
  ): Promise<null> {
    await this.notifications.registerDevice(principal, body);
    return null;
  }
}
