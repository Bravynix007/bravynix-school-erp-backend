import request from 'supertest';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import type { TestApp } from './test-app.js';

const device = { platform: 1, label: 'Pixel 8', appVersion: '1.4.0' };

export interface LoginData {
  accessToken: string;
  refreshToken: string;
  userType: number | null;
  session: { id: string; activeContext: { roleCode: number; societyId: string | null } | null };
  contexts: { roleCode: number; societyId: string | null }[];
}

/**
 * Signs in by email code on a mobile device and returns the login data. `ip`
 * is the caller's address (X-Forwarded-For, when the app trusts one proxy).
 */
export async function signInMobile(t: TestApp, email: string, ip?: string): Promise<LoginData> {
  const http = t.app.getHttpServer();
  const post = (path: string) => {
    const call = request(http).post(path);
    return ip ? call.set('X-Forwarded-For', ip) : call;
  };
  await post('/v1/auth/otp').send({ email, clientType: 1 }).expect(202);
  await t.app.get(OtpService).flush();
  const code = t.email.latest(email, 'otp')!.variables!.code as string;
  const res = await post('/v1/auth/otp/verify')
    .send({ email, code, clientType: 1, device })
    .expect(200);
  t.clock.advance(61_000);
  return res.body.data as LoginData;
}

/** Signs in and chooses a context; returns the access token for it. */
export async function signInAs(
  t: TestApp,
  email: string,
  context: { roleCode: number; societyId: string },
): Promise<string> {
  const login = await signInMobile(t, email);
  const res = await request(t.app.getHttpServer())
    .post('/v1/auth/context')
    .set('Authorization', `Bearer ${login.accessToken}`)
    .send(context)
    .expect(200);
  return res.body.data.accessToken as string;
}
