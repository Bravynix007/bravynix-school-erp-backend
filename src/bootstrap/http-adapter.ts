import { ExpressAdapter } from '@nestjs/platform-express';

function envelopeStatus(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null || !('success' in body)) return undefined;
  const status = (body as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The HTTP status always equals the envelope's `statusCode`. Without this,
 * Nest answers every POST with 201, so a logout or an OTP request would say
 * 201 while the contract says 200 (API design 7.1, 7.5).
 */
export class EnvelopeExpressAdapter extends ExpressAdapter {
  override reply(response: unknown, body: unknown, statusCode?: number): unknown {
    return super.reply(response, body, envelopeStatus(body) ?? statusCode);
  }
}
