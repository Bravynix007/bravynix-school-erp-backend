/**
 * QA edge cases for the Phase 0 HTTP stack (QA strategy 7.11; API design 7, 8,
 * 12.1, 13.1, 18.3, 20.1). These complement http-stack.e2e-spec.ts and look
 * for the cases a client or an attacker would hit first.
 */
import request from 'supertest';
import {
  AccessTokenVerifier,
  type Principal,
} from '../../../src/common/auth/access-token-verifier.js';
import { FixtureModule } from '../../support/fixture.module.js';
import { createTestApp, type TestApp } from '../../support/test-app.js';

class FakeVerifier extends AccessTokenVerifier {
  verify(token: string): Promise<Principal> {
    const match = /^role-(\d)(-support)?$/.exec(token);
    if (!match) return Promise.reject(new Error('bad token'));
    return Promise.resolve({
      personId: '0192f6a1-7c40-7e21-8b55-000000000001',
      sessionId: '0192f6a1-7c40-7e21-8b55-000000000002',
      roleCode: Number(match[1]) as Principal['roleCode'],
      societyId: null,
      clientType: 'console',
      viaSupportAccess: Boolean(match[2]),
    });
  }
}

describe('QA: foundation edge cases', () => {
  let t: TestApp;
  let http: ReturnType<TestApp['app']['getHttpServer']>;

  beforeAll(async () => {
    t = await createTestApp({ imports: [FixtureModule], verifier: new FakeVerifier() });
    http = t.app.getHttpServer();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('request body hardening (API design 7.4)', () => {
    it('refuses a wrongly typed field with INVALID_TYPE, not coercion', async () => {
      const res = await request(http).post('/v1/fixtures/echo').send({ name: 123 });
      expect(res.status).toBe(400);
      expect(res.body.errors).toContainEqual(
        expect.objectContaining({ field: 'name', code: 'INVALID_TYPE' }),
      );
    });

    it('refuses a top-level JSON array body', async () => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json')
        .send('[{"name":"x"}]');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('refuses a JSON null body', async () => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json')
        .send('null');
      expect(res.status).toBe(400);
    });

    it('refuses __proto__ and constructor keys and never pollutes Object.prototype', async () => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json')
        .send('{"name":"x","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"p2":1}}}');
      expect(res.status).toBe(400);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(({} as Record<string, unknown>)['p2']).toBeUndefined();
    });

    it('treats a whitespace-only required string as REQUIRED', async () => {
      const res = await request(http).post('/v1/fixtures/echo').send({ name: ' \t\n ' });
      expect(res.status).toBe(400);
      expect(res.body.errors).toContainEqual(
        expect.objectContaining({ field: 'name', code: 'REQUIRED' }),
      );
    });

    it('survives deeply nested JSON without a 500', async () => {
      const depth = 200_000;
      const body = `{"name":"x","deep":${'['.repeat(depth)}${']'.repeat(depth)}}`;
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBeLessThan(500);
    });

    it('accepts charset=UTF-8 in any case and refuses other charsets', async () => {
      const ok = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json; charset=UTF-8')
        .send('{"name":"x"}');
      expect(ok.status).toBe(201);
      const latin = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json; charset=latin1')
        .send('{"name":"x"}');
      expect(latin.status).toBe(415);
    });

    it('accepts a quoted charset parameter (RFC 9110 allows it)', async () => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json; charset="utf-8"')
        .send('{"name":"x"}');
      expect(res.status).toBe(201);
    });

    it('refuses form-encoded and multipart bodies with 415', async () => {
      const form = await request(http).post('/v1/fixtures/echo').type('form').send('name=x');
      expect(form.status).toBe(415);
      const multi = await request(http).post('/v1/fixtures/echo').field('name', 'x');
      expect(multi.status).toBe(415);
    });
  });

  describe('field error contract (API design 12.1)', () => {
    it('uses OUT_OF_RANGE with params.max for a number above its limit', async () => {
      const res = await request(http).post('/v1/fixtures/echo').send({ name: 'x', score: 101 });
      expect(res.status).toBe(400);
      const err = res.body.errors.find((e: { field: string }) => e.field === 'score');
      expect(err.code).toBe('OUT_OF_RANGE');
      expect(err.params).toEqual({ max: 100 });
    });

    it('uses TOO_LONG with params.max for a long string', async () => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .send({ name: 'x'.repeat(21) });
      const err = res.body.errors.find((e: { field: string }) => e.field === 'name');
      expect(err.code).toBe('TOO_LONG');
      expect(err.params).toEqual({ max: 20 });
    });
  });

  describe('pagination (API design 13.1)', () => {
    it.each([
      ['page=0', 'page'],
      ['page=-1', 'page'],
      ['page=1.5', 'page'],
      ['limit=0', 'limit'],
      ['limit=abc', 'limit'],
      ['q=a', 'q'],
    ])('rejects %s as 400 on %s', async (query, field) => {
      const res = await request(http).get(`/v1/fixtures/page?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(field);
    });

    it('accepts limit=100 exactly', async () => {
      const res = await request(http).get('/v1/fixtures/page?limit=100');
      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(100);
    });

    it('answers a repeated scalar parameter with 400, not 500', async () => {
      const res = await request(http).get('/v1/fixtures/page?limit=10&limit=20');
      expect(res.status).toBe(400);
    });

    it('refuses an absurd page number before it reaches the database', async () => {
      const res = await request(http).get('/v1/fixtures/page?page=100000000000000000000');
      expect(res.status).toBe(400);
    });

    it('refuses unknown query parameters', async () => {
      const res = await request(http).get('/v1/fixtures/page?foo=bar');
      expect(res.status).toBe(400);
      expect(res.body.errors).toContainEqual(
        expect.objectContaining({ field: 'foo', code: 'FIELD_NOT_ALLOWED' }),
      );
    });
  });

  describe('security headers (API design 18.3)', () => {
    it.each([
      ['a success', '/v1/fixtures/plain'],
      ['a 404', '/v1/nope'],
      ['a 500', '/v1/fixtures/boom'],
    ])('sets the hardening headers on %s', async (_label, path) => {
      const res = await request(http).get(path);
      expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['server']).toBeUndefined();
    });

    it('never puts internals in a 500 body', async () => {
      const res = await request(http).get('/v1/fixtures/boom');
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/students_pkey|\/srv\/app|at .*\.ts|stack/i);
    });
  });

  describe('CORS (API design 18.3)', () => {
    it('allows the console origin with credentials', async () => {
      const res = await request(http)
        .options('/v1/fixtures/owner-write')
        .set('Origin', 'http://localhost:3001')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it.each(['https://evil.example', 'null', 'http://localhost:3001.evil.example'])(
      'gives no CORS grant to origin %s',
      async (origin) => {
        const res = await request(http)
          .options('/v1/fixtures/owner-write')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      },
    );
  });

  describe('request ID (API design 20.1)', () => {
    it('matches header and body on errors too', async () => {
      const res = await request(http).get('/v1/nope');
      expect(res.headers['x-request-id']).toBe(res.body.requestId);
      expect(res.body.requestId).not.toBe('');
    });

    it('replaces a header-injection attempt', async () => {
      const res = await request(http)
        .get('/v1/fixtures/plain')
        .set('X-Request-Id', 'abc" , "admin":true');
      expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('policy guard (API design 6.4)', () => {
    it('answers 401 before 415 for an anonymous call with a bad content type', async () => {
      const res = await request(http)
        .post('/v1/fixtures/owner-write')
        .set('Content-Type', 'text/plain')
        .send('x');
      expect(res.status).toBe(401);
    });

    it.each(['Basic cm9sZS0x', 'Bearer', 'Bearer ', 'role-1', 'Bearer role-1 extra'])(
      'refuses a malformed Authorization header: %s',
      async (header) => {
        const res = await request(http).get('/v1/fixtures/admin-only').set('Authorization', header);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('TOKEN_INVALID');
      },
    );

    it('keeps a support session read-only for HEAD-less writes of every verb', async () => {
      const agent = request(http);
      for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await agent[verb]('/v1/fixtures/owner-write').set(
          'Authorization',
          'Bearer role-1-support',
        );
        // PUT/PATCH/DELETE have no route here, so 404 is also acceptable.
        expect([403, 404]).toContain(res.status);
        if (res.status === 403) expect(res.body.code).toBe('SUPPORT_READ_ONLY');
      }
    });

    it('returns 404, not 405 or a policy error, for a wrong method on a real path', async () => {
      const res = await request(http).delete('/v1/fixtures/plain');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('health (API design 5.1)', () => {
    it('is not reachable under /v1', async () => {
      const res = await request(http).get('/v1/health/live');
      expect(res.status).toBe(404);
    });
  });
});
