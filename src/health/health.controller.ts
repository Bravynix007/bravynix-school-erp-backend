import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/auth/policy.decorator.js';
import { RawResponse } from '../common/http/raw-response.decorator.js';
import { DatabaseService } from '../platform/database/database.service.js';

/**
 * Load-balancer health checks, outside `/v1`. They return no data
 * (API design 5.1, SDD 16.7): `live` means the process runs, `ready` means it
 * can also reach the database.
 */
@ApiExcludeController()
@RawResponse()
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Public({ rule: 'Load balancer only; returns no data' })
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public({ rule: 'Load balancer only; returns no data' })
  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'ok' | 'unavailable' }> {
    const ok = await this.database.ping();
    response.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    response.setHeader('Cache-Control', 'no-store');
    return { status: ok ? 'ok' : 'unavailable' };
  }
}
