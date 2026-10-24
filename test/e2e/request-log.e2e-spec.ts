/**
 * The real request log line, read back from pino (API design 20.2, SDD
 * 17.1): one line per request with the route template and outcome code, the
 * caller once known, and never a URL, query, header or body.
 */
import request from 'supertest';
import {
  AccessTokenVerifier,
  type Principal,
} from '../../src/common/auth/access-token-verifier.js';
import { RoleCode } from '../../src/common/auth/roles.js';
import { FixtureModule } from '../support/fixture.module.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const PERSON_ID = '0192f6a1-7c40-7e21-8b55-000000000001';
const SOCIETY_ID = '0192f6a1-7c40-7e21-8b55-0000000000aa';

class OwnerVerifier extends AccessTokenVerifier {
  verify(token: string): Promise<Principal> {
    if (token !== 'owner') return Promise.reject(new Error('bad token'));
    return Promise.resolve({
      personId: PERSON_ID,
      sessionId: '0192f6a1-7c40-7e21-8b55-000000000002',
      roleCode: RoleCode.SocietyOwner,
      societyId: SOCIETY_ID,
      clientType: 'console',
      viaSupportAccess: false,
    });
  }
}

describe('request log line (API design 20.2)', () => {
  let t: TestApp;
  let http: ReturnType<TestApp['app']['getHttpServer']>;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FixtureModule],
      verifier: new OwnerVerifier(),
      captureLogs: true,
    });
    http = t.app.getHttpServer();
  });
  afterAll(async () => {
    await t.close();
  });

  /** The completion line for a request; pino writes it on `finish`, just after the reply. */
  async function lineFor(requestId: string): Promise<Record<string, unknown>> {
    let line: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      line = t.logs.find(
        (entry) =>
          (entry['req'] as { id?: string } | undefined)?.id === requestId &&
          typeof entry['responseTime'] === 'number',
      );
      expect(line).toBeDefined();
    });
    return line!;
  }

  it('logs the route template and code, never the query', async () => {
    const res = await request(http)
      .get('/v1/fixtures/page?q=ananya.rao@gmail.com')
      .set('X-App-Platform', 'android')
      .set('X-App-Version', '1.4.2+57')
      .expect(200);
    const line = await lineFor(res.body.requestId);
    expect(line).toMatchObject({
      level: 30,
      req: { id: res.body.requestId, method: 'GET' },
      res: { statusCode: 200 },
      route: '/v1/fixtures/page',
      code: 'OK',
      appPlatform: 'android',
      appVersion: '1.4.2+57',
    });
    expect(JSON.stringify(line)).not.toContain('ananya');
  });

  it('logs who called, from the authenticated principal', async () => {
    const res = await request(http)
      .post('/v1/fixtures/owner-write')
      .set('Authorization', 'Bearer owner')
      .send({})
      .expect(200);
    const line = await lineFor(res.body.requestId);
    expect(line).toMatchObject({
      route: '/v1/fixtures/owner-write',
      code: 'OK',
      clientType: 'console',
      personId: PERSON_ID,
      societyId: SOCIETY_ID,
      roleCode: RoleCode.SocietyOwner,
    });
    expect(JSON.stringify(line)).not.toMatch(/Bearer|owner"/);
  });

  it('logs the error code, and a sanitised path when no route matched', async () => {
    const res = await request(http).get('/v1/people/ananya.rao@gmail.com').expect(404);
    const line = await lineFor(res.body.requestId);
    expect(line).toMatchObject({ path: '/v1/:value/:value', code: 'NOT_FOUND' });
    expect(line['route']).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain('ananya');
  });

  it('logs a 500 at error level with its route and code', async () => {
    const res = await request(http).get('/v1/fixtures/boom').expect(500);
    const line = await lineFor(res.body.requestId);
    expect(line).toMatchObject({
      level: 50,
      msg: 'request errored',
      route: '/v1/fixtures/boom',
      code: 'INTERNAL_ERROR',
      res: { statusCode: 500 },
    });
  });

  it('writes each request field once, on the completion line only', async () => {
    const res = await request(http).get('/v1/fixtures/plain').expect(200);
    const line = await lineFor(res.body.requestId);
    const raw = JSON.stringify(line);
    expect(raw.match(/"route"/g)).toHaveLength(1);
    expect(raw.match(/"code"/g)).toHaveLength(1);
  });
});
