import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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
import { DatabaseService, platformTenant } from '../../src/platform/database/index.js';
import { IdempotencyModule, IdempotencyService } from '../../src/platform/idempotency/index.js';
import { NumberingModule, NumberSequenceService } from '../../src/platform/numbering/index.js';
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
    allowWhenBlocked: true,
  })
  @Get('owner-read-when-blocked')
  ownerReadWhenBlocked(): { ok: true } {
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

class IdempotentBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  note?: string;
}

/** What the idempotent fixture saw, so a test can tell a replay from a second run. */
export const idempotentFixture = {
  runs: 0,
  attempts: new Map<string, number>(),
  /** Held open by a `slow` call until the test calls `release`. */
  gate: undefined as Promise<void> | undefined,
  release: undefined as (() => void) | undefined,
  reset(): void {
    this.runs = 0;
    this.attempts.clear();
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  },
};

/**
 * A test-only operation built the way a real one is (API design 14): it takes
 * a platform invoice number inside the idempotent transaction, so a test can
 * see replays, rollbacks and refusals in the numbers handed out.
 */
@Controller('fixtures/idempotent')
class IdempotentFixtureController {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly numbers: NumberSequenceService,
    private readonly clock: Clock,
  ) {}

  @Policy({ roles: [RoleCode.SuperAdmin], scope: 'platform', operationId: 'FIX-03' })
  @Post(':mode')
  async run(
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') key: string | undefined,
    @Param('mode') mode: string,
    @Body() body: IdempotentBodyDto,
  ): Promise<ApiResult<{ invoiceNo: string }>> {
    return this.idempotency.run(
      {
        tenant: platformTenant(principal),
        key,
        operation: 'fixtures.idempotent',
        request: { mode, body },
      },
      async (tx) => {
        idempotentFixture.runs += 1;
        const attempt = (idempotentFixture.attempts.get(key ?? '') ?? 0) + 1;
        idempotentFixture.attempts.set(key ?? '', attempt);
        const invoiceNo = await this.numbers.nextPlatformInvoice(tx, this.clock.todayIst());
        if (mode === 'slow') await idempotentFixture.gate;
        if (mode === 'refuse') throw AppException.businessRule('BUSINESS_RULE');
        if (mode === 'conflict') throw AppException.conflict('DUPLICATE');
        if (mode === 'invalid') throw AppException.validation([]);
        // Fails once, after taking a number, then works on the retry.
        if (mode === 'flaky' && attempt === 1) throw new Error('the database went away');
        return { result: ApiResult.created({ invoiceNo }), resourceId: undefined };
      },
    );
  }
}

@Module({
  imports: [IdempotencyModule, NumberingModule],
  controllers: [FixtureController, TenantFixtureController, IdempotentFixtureController],
})
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
