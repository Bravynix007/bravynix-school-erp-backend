import { Body, Controller, Get, HttpStatus, Module, Param, Post, Query } from '@nestjs/common';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Principal } from '../../src/common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../src/common/auth/current-principal.decorator.js';
import { Policy, Public } from '../../src/common/auth/policy.decorator.js';
import { RoleCode } from '../../src/common/auth/roles.js';
import { ApiResult } from '../../src/common/http/api-result.js';
import { AppException } from '../../src/common/http/app-exception.js';
import { RawResponse } from '../../src/common/http/raw-response.decorator.js';
import { PageQueryDto, pageMeta } from '../../src/common/pagination/pagination.js';
import { Clock } from '../../src/common/time/clock.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { EmailSender } from '../../src/platform/email/email-sender.js';
import { ScopeService } from '../../src/platform/tenancy/index.js';

class EchoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  name!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  // No @Type here: a body is JSON, which already has numbers, so "5" must
  // fail as INVALID_TYPE (API design 12.1). @Type belongs on query DTOs only,
  // where every value arrives as a string.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  score?: number;
}

/** Test-only endpoints that exercise the shared HTTP stack. */
@Controller('fixtures')
class FixtureController {
  constructor(
    private readonly clock: Clock,
    private readonly email: EmailSender,
  ) {}

  @Public()
  @Get('plain')
  plain(): { hello: string } {
    return { hello: 'world' };
  }

  @Public()
  @Get('nothing')
  nothing(): void {
    return undefined;
  }

  @Public()
  @Post('echo')
  echo(@Body() body: EchoDto): ApiResult<EchoDto> {
    return ApiResult.created(body, 'ECHOED', 'Echoed');
  }

  @Public()
  @Post('plain-post')
  plainPost(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Post('queued')
  queued(): ApiResult<{ operationId: string }> {
    return ApiResult.accepted({ operationId: 'op-1' });
  }

  @Public()
  @Get('page')
  page(@Query() query: PageQueryDto): ApiResult<{ items: number[]; q: string | null }> {
    return new ApiResult(
      { items: [1, 2], q: query.q ?? null },
      { meta: pageMeta(query.page, query.limit, 2) },
    );
  }

  @Public()
  @Get('now')
  now(): { now: string; today: string } {
    return { now: this.clock.now().toISOString(), today: this.clock.todayIst() };
  }

  @Public()
  @Post('mail')
  async mail(@Body() body: { to: string }): Promise<null> {
    await this.email.send({
      to: body.to,
      subject: 'Code',
      text: 'Your code is 123456',
      template: 'otp',
      variables: { code: '123456' },
    });
    return null;
  }

  /** A raw body shaped like an envelope; it must not set the status (R-B5). */
  @Public()
  @RawResponse()
  @Get('raw-lookalike')
  rawLookalike(): Record<string, unknown> {
    return { success: false, statusCode: 418, code: 'TEAPOT' };
  }

  @Public()
  @Get('boom')
  boom(): never {
    throw new Error('secret table students_pkey violated at /srv/app');
  }

  @Public()
  @Get('limited')
  limited(): never {
    throw new AppException(HttpStatus.TOO_MANY_REQUESTS, 'OTP_RESEND_TOO_SOON', {
      retryAfterSeconds: 42.2,
      details: { attemptsLeft: 2 },
    });
  }

  @Policy({ roles: [RoleCode.SuperAdmin], scope: 'platform', operationId: 'FIX-01' })
  @Get('admin-only')
  adminOnly(): { ok: true } {
    return { ok: true };
  }

  @Policy({
    roles: [RoleCode.SuperAdmin, RoleCode.SocietyOwner],
    scope: 'society',
    allowWhenPaused: true,
  })
  @Get('owner-read-when-paused')
  ownerReadWhenPaused(): { ok: true } {
    return { ok: true };
  }

  @Policy({ roles: [RoleCode.SuperAdmin, RoleCode.SocietyOwner], scope: 'society' })
  @Post('owner-write')
  ownerWrite(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Test-only endpoints that show how a module uses the tenant scope check
 * (API design 6.4 check 2) and the transaction scope (DDD 15.3).
 */
@Controller('fixtures/tenant')
class TenantFixtureController {
  constructor(
    private readonly scope: ScopeService,
    private readonly database: DatabaseService,
  ) {}

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin],
    scope: 'institution',
    operationId: 'FIX-02',
  })
  @Get('institutions/:institutionId')
  async institution(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId') institutionId: string,
  ): Promise<{ id: string; name: string }> {
    const context = await this.scope.requireInstitution(principal, institutionId);
    return this.database.transaction(context.tenant, (tx) =>
      tx
        .selectFrom('institutions')
        .select(['id', 'name'])
        .where('id', '=', institutionId)
        .executeTakeFirstOrThrow(),
    );
  }

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin],
    scope: 'institution',
    operationId: 'FIX-03',
  })
  @Post('institutions/:institutionId/rename')
  async rename(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId') institutionId: string,
    @Body() body: EchoDto,
  ): Promise<{ renamed: number }> {
    const context = await this.scope.requireInstitution(principal, institutionId);
    const result = await this.database.transaction(context.tenant, (tx) =>
      tx
        .updateTable('institutions')
        .set({ name: body.name })
        .where('id', '=', institutionId)
        .executeTakeFirst(),
    );
    return { renamed: Number(result.numUpdatedRows) };
  }

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin],
    scope: 'society',
    operationId: 'FIX-04',
  })
  @Get('societies/:societyId')
  async society(
    @CurrentPrincipal() principal: Principal,
    @Param('societyId') societyId: string,
  ): Promise<{ id: string; name: string }> {
    this.scope.requireSociety(principal, societyId);
    return this.database.transaction({ societyId, roleCode: principal.roleCode }, (tx) =>
      tx
        .selectFrom('societies')
        .select(['id', 'name'])
        .where('id', '=', societyId)
        .executeTakeFirstOrThrow(),
    );
  }
}

@Module({ controllers: [FixtureController, TenantFixtureController] })
export class FixtureModule {}

/** A controller that forgets its policy; the app must refuse to start. */
@Controller('forgetful')
class ForgetfulController {
  @Get()
  get(): string {
    return 'should never be served';
  }
}

@Module({ controllers: [ForgetfulController] })
export class ForgetfulModule {}
