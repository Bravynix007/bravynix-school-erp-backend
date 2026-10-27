import request from 'supertest';
import {
  AccessTokenVerifier,
  type Principal,
} from '../../src/common/auth/access-token-verifier.js';
import { BlockSection } from '../../src/common/auth/block-section.js';
import { TenantAccessGate } from '../../src/common/auth/tenant-access-gate.js';
import { FixtureModule } from '../support/fixture.module.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const BLOCKED_SOCIETY = '0192f6a1-7c40-7e21-8b55-0000000000a1';
const OPEN_SOCIETY = '0192f6a1-7c40-7e21-8b55-0000000000b1';

/** `owner-blocked`, `owner-open`, `admin` (Super Admin with no Society). */
class FakeVerifier extends AccessTokenVerifier {
  verify(token: string): Promise<Principal> {
    const base = {
      personId: '0192f6a1-7c40-7e21-8b55-000000000001',
      sessionId: '0192f6a1-7c40-7e21-8b55-000000000002',
      clientType: 'mobile',
      viaSupportAccess: false,
    } as const;
    switch (token) {
      case 'owner-blocked':
        return Promise.resolve({ ...base, roleCode: 2, societyId: BLOCKED_SOCIETY });
      case 'owner-open':
        return Promise.resolve({ ...base, roleCode: 2, societyId: OPEN_SOCIETY });
      case 'admin':
        return Promise.resolve({ ...base, roleCode: 1, societyId: null });
      default:
        return Promise.reject(new Error('bad token'));
    }
  }
}

class FakeGate extends TenantAccessGate {
  readonly asked: (string | null)[] = [];
  blockedSection(principal: Principal): Promise<BlockSection | null> {
    this.asked.push(principal.societyId);
    return Promise.resolve(principal.societyId === BLOCKED_SOCIETY ? BlockSection.Owners : null);
  }
}

describe('Section blocks on every request (API design 6.5)', () => {
  let t: TestApp;
  const gate = new FakeGate();
  let http: ReturnType<TestApp['app']['getHttpServer']>;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FixtureModule],
      verifier: new FakeVerifier(),
      tenantGate: gate,
    });
    http = t.app.getHttpServer();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    gate.asked.length = 0;
  });

  it('answers 423 SECTION_BLOCKED with the catalogue message and the section, but not the reason', async () => {
    const res = await request(http)
      .post('/v1/fixtures/owner-write')
      .set('Authorization', 'Bearer owner-blocked')
      .send({});
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({
      success: false,
      code: 'SECTION_BLOCKED',
      message: 'Access is blocked for your group, please contact your Society',
      data: { section: 'owners' },
    });
    expect(JSON.stringify(res.body)).not.toContain('reason');
  });

  it('serves the same call to a Society that is not blocked', async () => {
    await request(http)
      .post('/v1/fixtures/owner-write')
      .set('Authorization', 'Bearer owner-open')
      .send({})
      .expect(200);
  });

  it('still serves an endpoint that is declared open while blocked', async () => {
    await request(http)
      .get('/v1/fixtures/owner-read-when-blocked')
      .set('Authorization', 'Bearer owner-blocked')
      .expect(200);
  });

  it('never stops Super Admin, who belongs to no Society, and does not even ask', async () => {
    await request(http)
      .post('/v1/fixtures/owner-write')
      .set('Authorization', 'Bearer admin')
      .send({})
      .expect(200);
    expect(gate.asked).toEqual([]);
  });

  it('checks the role before the block, so a block does not reveal what the role may not call', async () => {
    await request(http)
      .get('/v1/fixtures/admin-only')
      .set('Authorization', 'Bearer owner-blocked')
      .expect(403);
  });

  it('does not ask about blocks for a call with a bad token', async () => {
    await request(http)
      .post('/v1/fixtures/owner-write')
      .set('Authorization', 'Bearer nope')
      .expect(401);
    expect(gate.asked).toEqual([]);
  });
});
