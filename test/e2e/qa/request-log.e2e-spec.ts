/**
 * QA: every request gets one log line (API design 20.2), including those the
 * JSON body middleware rejects. Abuse traffic (malformed, oversized, wrongly
 * encoded or deeply nested bodies) is exactly what operators need to see.
 */
import request from 'supertest';
import { FixtureModule } from '../../support/fixture.module.js';
import { createTestApp, type TestApp } from '../../support/test-app.js';

describe('QA: request log covers rejected bodies', () => {
  let t: TestApp;
  let http: ReturnType<TestApp['app']['getHttpServer']>;

  beforeAll(async () => {
    t = await createTestApp({ imports: [FixtureModule], captureLogs: true });
    http = t.app.getHttpServer();
  });
  afterAll(async () => {
    await t.close();
  });

  const requestLines = () => t.logs.filter((line) => 'res' in line && 'req' in line);

  it.each([
    ['malformed JSON', 'application/json', '{bad', 400],
    ['an over-1 MB body', 'application/json', `{"name":"${'x'.repeat(1_100_000)}"}`, 413],
    ['a UTF-16 charset', 'application/json; charset=utf-16le', '{"name":"x"}', 415],
    ['a body nested 40 deep', 'application/json', `{"a":${'['.repeat(40)}${']'.repeat(40)}}`, 400],
  ])('writes a log line for %s', async (_label, type, body, status) => {
    const before = requestLines().length;
    const res = await request(http).post('/v1/fixtures/echo').set('Content-Type', type).send(body);
    expect(res.status).toBe(status);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = requestLines().slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ code: res.body.code });
    expect(JSON.stringify(lines[0])).not.toContain('xxxxxxxx');
  });
});
