import { ExpressAdapter } from '@nestjs/platform-express';
import type { Response } from 'express';
import { isMarkedEnvelope } from '../common/http/api-result.js';

/**
 * The HTTP status always equals the envelope's `statusCode`. Without this,
 * Nest answers every POST with 201, so a logout or an OTP request would say
 * 201 while the contract says 200 (API design 7.1, 7.5). The envelope's
 * `code` is kept for the request log line (API design 20.2). Only envelopes
 * the interceptor marked count; raw bodies keep Nest's status.
 */
export class EnvelopeExpressAdapter extends ExpressAdapter {
  override reply(response: unknown, body: unknown, statusCode?: number): unknown {
    if (!isMarkedEnvelope(body)) return super.reply(response, body, statusCode);
    (response as Response).locals['code'] = body.code;
    return super.reply(response, body, body.statusCode);
  }
}
