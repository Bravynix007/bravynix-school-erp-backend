import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function answer(exception: unknown) {
  const headers: Record<string, string> = {};
  const sent = vi.fn<(body: Record<string, unknown>) => void>();
  const status = vi.fn<(code: number) => { json: typeof sent }>(() => ({ json: sent }));
  const response = {
    locals: {},
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status,
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status: status.mock.calls[0]![0], body: sent.mock.calls[0]![0], headers };
}

describe('AllExceptionsFilter: database lock contention (API design 14.4)', () => {
  it.each([
    ['a lock not obtained in time', '55P03'],
    ['a deadlock', '40P01'],
  ])('answers 409 RESOURCE_BUSY with Retry-After 1 for %s', (_what, code) => {
    const { status, body, headers } = answer(Object.assign(new Error('lock'), { code }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, code: 'RESOURCE_BUSY', data: null });
    expect(body['message']).toBe('Someone else is changing this right now, please try again');
    expect(headers['Retry-After']).toBe('1');
  });

  it('still answers 500 INTERNAL_ERROR, with nothing internal, for any other database error', () => {
    const { status, body, headers } = answer(
      Object.assign(new Error('relation x does not exist'), { code: '42P01' }),
    );
    expect(status).toBe(500);
    expect(body['code']).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('relation');
    expect(headers['Retry-After']).toBeUndefined();
  });
});
