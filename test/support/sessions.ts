import request from 'supertest';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import type { TestApp } from './test-app.js';

const device = { platform: 1, label: 'Pixel 8', appVersion: '1.4.0' };

/** Signs in by email code on a mobile device and returns the login data. */
export async function signInMobile(t: TestApp, email: string) {
  const http = t.app.getHttpServer();
  await request(http).post('/v1/auth/otp').send({ email, clientType: 1 }).expect(202);
  await t.app.get(OtpService).flush();
  const code = t.email.latest(email, 'otp')!.variables!.code as string;
  const res = await request(http)
    .post('/v1/auth/otp/verify')
    .send({ email, code, clientType: 1, device })
    .expect(200);
  t.clock.advance(61_000);
  return res.body.data as {
    accessToken: string;
    contexts: { roleCode: number; societyId: string | null }[];
  };
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
