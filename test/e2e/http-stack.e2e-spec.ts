import request from 'supertest';
import {
  AccessTokenVerifier,
  type Principal,
} from '../../src/common/auth/access-token-verifier.js';
import { AppException } from '../../src/common/http/app-exception.js';
import { RoleCode } from '../../src/common/auth/roles.js';
import { FixtureModule, ForgetfulModule } from '../support/fixture.module.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Tokens of the form `role-<code>[-support]` stand in for phase 1's real tokens. */
class FakeVerifier extends AccessTokenVerifier {
  verify(token: string): Promise<Principal> {
    const match = /^role-(\d)(-support)?$/.exec(token);
    if (token === 'expired') return Promise.reject(AppException.unauthorized('TOKEN_EXPIRED'));
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

describe('HTTP stack', () => {
  let t: TestApp;
  let http: ReturnType<TestApp['app']['getHttpServer']>;

  beforeAll(async () => {
    t = await createTestApp({ imports: [FixtureModule], verifier: new FakeVerifier() });
    http = t.app.getHttpServer();
  });

  afterAll(async () => {
    await t.close();
  });

  describe('envelope (API design 7.1)', () => {
    it('wraps plain return values as 200 OK', async () => {
      const res = await request(http).get('/v1/fixtures/plain').expect(200);
      expect(res.body).toEqual({
        success: true,
        statusCode: 200,
        code: 'OK',
        message: 'OK',
        data: { hello: 'world' },
        meta: null,
        requestId: expect.stringMatching(UUID),
      });
      expect(res.headers['x-request-id']).toBe(res.body.requestId);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('never sends 204: nothing to return is 200 with data null', async () => {
      const res = await request(http).get('/v1/fixtures/nothing').expect(200);
      expect(res.body.data).toBeNull();
    });

    it('carries named codes, statuses and list meta', async () => {
      const created = await request(http)
        .post('/v1/fixtures/echo')
        .send({ name: 'Asha' })
        .expect(201);
      expect(created.body).toMatchObject({ statusCode: 201, code: 'ECHOED', message: 'Echoed' });

      const page = await request(http).get('/v1/fixtures/page?page=2&limit=1').expect(200);
      expect(page.body.meta).toEqual({ page: 2, limit: 1, totalItems: 2, totalPages: 2 });

      const queued = await request(http).post('/v1/fixtures/queued').expect(202);
      expect(queued.body).toMatchObject({ statusCode: 202, code: 'ACCEPTED' });
    });

    it('answers a plain POST with 200, not the Nest default of 201 (API design 7.5)', async () => {
      const res = await request(http).post('/v1/fixtures/plain-post').expect(200);
      expect(res.body).toMatchObject({ statusCode: 200, code: 'OK', data: { ok: true } });
    });

    it('refuses a numeric string in a body as INVALID_TYPE, never coercing it', async () => {
      const res = await request(http).post('/v1/fixtures/echo').send({ name: 'Asha', score: '5' });
      expect(res.status).toBe(400);
      expect(res.body.errors).toContainEqual(
        expect.objectContaining({ field: 'score', code: 'INVALID_TYPE' }),
      );
    });

    it('trims query strings, which Express 5 parses with a null prototype', async () => {
      const res = await request(http).get('/v1/fixtures/page?q=%20%20vidya%20').expect(200);
      expect(res.body.data.q).toBe('vidya');
    });

    it('accepts a quoted charset and refuses the utf8 alias with the envelope', async () => {
      await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json; charset="UTF-8"')
        .send(JSON.stringify({ name: 'Asha' }))
        .expect(201);
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json; charset=utf8')
        .send(JSON.stringify({ name: 'Asha' }))
        .expect(415);
      expect(res.body).toMatchObject({ success: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
    });

    it('refuses UTF-16 JSON before parsing it, even when nested deeply', async () => {
      // U+2200 is the bytes 0x22 0x00 in UTF-16LE, which a UTF-8 scan reads as a quote.
      const body = Buffer.from(`{"a":"\u2200${'['.repeat(40)}"}`, 'utf16le');
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json; charset=utf-16le')
        .send(body)
        .expect(415);
      expect(res.body).toMatchObject({ success: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
    });

    it.each([
      ['spaces around the charset', 'application/json; charset = utf-16le'],
      ['a second charset after UTF-8', 'application/json; charset=utf-16le; charset=utf-8'],
    ])('refuses UTF-16 JSON written with %s', async (_name, contentType) => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', contentType)
        .send(Buffer.from('{"name":"Asha"}', 'utf16le'))
        .expect(415);
      expect(res.body).toMatchObject({ success: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
    });

    it('ignores the charset of a request without a body', async () => {
      await request(http)
        .get('/v1/fixtures/page')
        .set('Content-Type', 'application/json; charset=utf-16le')
        .expect(200);
    });

    it('keeps the status of a raw body that only looks like an envelope', async () => {
      const res = await request(http).get('/v1/fixtures/raw-lookalike').expect(200);
      expect(res.body).toEqual({ success: false, statusCode: 418, code: 'TEAPOT' });
    });

    it('echoes a client request ID when it is a UUID, and replaces it when not', async () => {
      const id = '0192f6a1-7c40-7e21-8b55-1a2b3c4d5e6f';
      const kept = await request(http).get('/v1/fixtures/plain').set('X-Request-Id', id);
      expect(kept.body.requestId).toBe(id);
      const replaced = await request(http).get('/v1/fixtures/plain').set('X-Request-Id', 'abc');
      expect(replaced.body.requestId).toMatch(UUID);
    });
  });

  describe('errors (API design 8)', () => {
    it('answers unknown routes with 404 NOT_FOUND in the envelope', async () => {
      const res = await request(http).get('/v1/does-not-exist').expect(404);
      expect(res.body).toMatchObject({ success: false, code: 'NOT_FOUND', data: null, meta: null });
    });

    it('rejects malformed JSON with MALFORMED_JSON', async () => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json')
        .send('{"name":')
        .expect(400);
      expect(res.body.code).toBe('MALFORMED_JSON');
    });

    it('rejects bodies over 1 MB with 413', async () => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ name: 'x'.repeat(1_100_000) }))
        .expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('rejects non-JSON bodies with 415', async () => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .set('Content-Type', 'text/plain')
        .send('name=x')
        .expect(415);
      expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('lists every failed field, rejects unknown fields and trims strings', async () => {
      const res = await request(http)
        .post('/v1/fixtures/echo')
        .send({ name: '   ', email: 'not-an-email', score: 101, createdBy: 'me' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'name', code: 'REQUIRED' }),
          expect.objectContaining({ field: 'email', code: 'INVALID_FORMAT' }),
          expect.objectContaining({ field: 'score', code: 'OUT_OF_RANGE' }),
          expect.objectContaining({ field: 'createdBy', code: 'FIELD_NOT_ALLOWED' }),
        ]),
      );

      const trimmed = await request(http)
        .post('/v1/fixtures/echo')
        .send({ name: '  Asha  ' })
        .expect(201);
      expect(trimmed.body.data.name).toBe('Asha');
    });

    it('rejects a page limit above 100', async () => {
      const res = await request(http).get('/v1/fixtures/page?limit=101').expect(400);
      expect(res.body.errors[0]).toMatchObject({ field: 'limit', code: 'OUT_OF_RANGE' });
    });

    it('hides internals of unexpected errors behind 500 INTERNAL_ERROR', async () => {
      const res = await request(http).get('/v1/fixtures/boom').expect(500);
      expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
      expect(JSON.stringify(res.body)).not.toMatch(/students_pkey|\/srv\/app|stack/);
    });

    it('sets Retry-After and sends details as data', async () => {
      const res = await request(http).get('/v1/fixtures/limited').expect(429);
      expect(res.headers['retry-after']).toBe('43');
      expect(res.body).toMatchObject({ code: 'OTP_RESEND_TOO_SOON', data: { attemptsLeft: 2 } });
      expect(res.body).not.toHaveProperty('attemptsLeft');
    });

    it('translates catalogue messages from Accept-Language, falling back to English', async () => {
      const res = await request(http).get('/v1/nowhere').set('Accept-Language', 'hi-IN');
      expect(res.body.message).toBe('Not found');
    });
  });

  describe('policy guard (API design 6.4)', () => {
    it('answers 401 TOKEN_INVALID without a token', async () => {
      const res = await request(http).get('/v1/fixtures/admin-only').expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    it('passes the verifier error through, e.g. TOKEN_EXPIRED', async () => {
      const res = await request(http)
        .get('/v1/fixtures/admin-only')
        .set('Authorization', 'Bearer expired')
        .expect(401);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    it('answers 401 for a token the verifier rejects', async () => {
      await request(http)
        .get('/v1/fixtures/admin-only')
        .set('Authorization', 'Bearer junk')
        .expect(401);
      await request(http)
        .get('/v1/fixtures/admin-only')
        .set('Authorization', 'Basic role-1')
        .expect(401);
    });

    it('answers 403 FORBIDDEN when the role is not allowed', async () => {
      const res = await request(http)
        .get('/v1/fixtures/admin-only')
        .set('Authorization', `Bearer role-${RoleCode.TeacherStaff}`)
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('lets an allowed role through', async () => {
      await request(http)
        .get('/v1/fixtures/admin-only')
        .set('Authorization', `Bearer role-${RoleCode.SuperAdmin}`)
        .expect(200);
    });

    it('lets a support session read with GET and HEAD', async () => {
      const auth = `Bearer role-${RoleCode.SuperAdmin}-support`;
      await request(http).get('/v1/fixtures/admin-only').set('Authorization', auth).expect(200);
      await request(http).head('/v1/fixtures/admin-only').set('Authorization', auth).expect(200);
    });

    it('keeps support sessions read-only', async () => {
      const res = await request(http)
        .post('/v1/fixtures/owner-write')
        .set('Authorization', `Bearer role-${RoleCode.SocietyOwner}-support`)
        .expect(403);
      expect(res.body.code).toBe('SUPPORT_READ_ONLY');
    });
  });

  describe('test seams (QA strategy 4)', () => {
    it('serves "now" from the injectable clock', async () => {
      t.clock.set('2026-10-22T20:00:00.000Z');
      const res = await request(http).get('/v1/fixtures/now').expect(200);
      expect(res.body.data).toEqual({ now: '2026-10-22T20:00:00.000Z', today: '2026-10-23' });
    });

    it('captures email in the in-memory sink', async () => {
      t.email.clear();
      await request(http)
        .post('/v1/fixtures/mail')
        .send({ to: 'SO-A1@two-worlds.test' })
        .expect(200);
      const sent = t.email.latest('so-a1@two-worlds.test', 'otp');
      expect(sent?.variables?.code).toBe('123456');
      // Stamped by the injectable clock, so FixedClock tests don't drift.
      expect(sent?.sentAt.toISOString()).toBe(t.clock.now().toISOString());
    });
  });

  describe('health checks (API design 5.1)', () => {
    it('serves live outside /v1, without the envelope', async () => {
      const res = await request(http).get('/health/live').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
      await request(http).get('/v1/health/live').expect(404);
    });
  });
});

describe('startup checks', () => {
  it('refuses to start when an endpoint has no @Policy or @Public', async () => {
    await expect(createTestApp({ imports: [ForgetfulModule] })).rejects.toThrow(
      /must declare @Policy or @Public[\s\S]*GET \/v1\/forgetful/,
    );
  });
});
