import express from 'express';
import request from 'supertest';
import { requestLogProps, serializeRequest } from './request-log.js';

/** Runs one request through a real Express app and returns the props logged at finish. */
async function propsFor(url: string, headers: Record<string, string> = {}) {
  const app = express();
  let props: Record<string, unknown> = {};
  app.use((req, res, next) => {
    res.on('finish', () => (props = requestLogProps(req, res)));
    next();
  });
  app.get('/v1/students/:studentId', (_req, res) => {
    res.locals['code'] = 'OK';
    res.json({ ok: true });
  });
  const call = request(app).get(url);
  for (const [name, value] of Object.entries(headers)) call.set(name, value);
  await call;
  return props;
}

describe('request log (API design 20.2)', () => {
  it('logs the route template, never the filled path or query', async () => {
    const props = await propsFor('/v1/students/0192f6a1?q=ananya.rao@gmail.com', {
      'X-App-Platform': 'android',
      'X-App-Version': '1.4.2+57',
    });
    expect(props).toMatchObject({
      route: '/v1/students/:studentId',
      code: 'OK',
      appPlatform: 'android',
      appVersion: '1.4.2+57',
    });
    expect(JSON.stringify(props)).not.toMatch(/ananya|0192f6a1/);
  });

  it('logs no route for an unmatched path', async () => {
    const props = await propsFor('/v1/people/ananya.rao@gmail.com');
    expect(props.route).toBeUndefined();
    expect(JSON.stringify(props)).not.toContain('ananya');
  });

  it('adds nothing before the response is sent, so no field repeats', () => {
    const res = { headersSent: false } as Parameters<typeof requestLogProps>[1];
    expect(requestLogProps({} as Parameters<typeof requestLogProps>[0], res)).toEqual({});
  });

  it('serializes the request without its URL', () => {
    expect(serializeRequest({ id: 'r1', method: 'GET', url: '/v1/x?q=a' } as never)).toEqual({
      id: 'r1',
      method: 'GET',
    });
  });
});
