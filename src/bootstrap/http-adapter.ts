import { ExpressAdapter } from '@nestjs/platform-express';
import type { Response } from 'express';

interface EnvelopeHead {
  statusCode: number;
  code: string;
}

function envelopeHead(body: unknown): EnvelopeHead | undefined {
  if (typeof body !== 'object' || body === null || !('success' in body)) return undefined;
  const { statusCode, code } = body as { statusCode?: unknown; code?: unknown };
  return typeof statusCode === 'number' && typeof code === 'string'
    ? { statusCode, code }
    : undefined;
}

/**
 * The HTTP status always equals the envelope's `statusCode`. Without this,
 * Nest answers every POST with 201, so a logout or an OTP request would say
 * 201 while the contract says 200 (API design 7.1, 7.5). The envelope's
 * `code` is kept for the request log line (API design 20.2).
 */
export class EnvelopeExpressAdapter extends ExpressAdapter {
  override reply(response: unknown, body: unknown, statusCode?: number): unknown {
    const head = envelopeHead(body);
    if (head) (response as Response).locals['code'] = head.code;
    return super.reply(response, body, head?.statusCode ?? statusCode);
  }
}
