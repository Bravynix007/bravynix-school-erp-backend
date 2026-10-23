import { Body, Controller, Get, HttpStatus, Module, Post, Query } from '@nestjs/common';
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
import { Type } from 'class-transformer';
import { Policy, Public } from '../../src/common/auth/policy.decorator.js';
import { RoleCode } from '../../src/common/auth/roles.js';
import { ApiResult } from '../../src/common/http/api-result.js';
import { AppException } from '../../src/common/http/app-exception.js';
import { PageQueryDto, pageMeta } from '../../src/common/pagination/pagination.js';
import { Clock } from '../../src/common/time/clock.js';
import { EmailSender } from '../../src/platform/email/email-sender.js';

class EchoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  name!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Type(() => Number)
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

  @Policy({ roles: [RoleCode.SuperAdmin, RoleCode.SocietyOwner], scope: 'society' })
  @Post('owner-write')
  ownerWrite(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [FixtureController] })
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
