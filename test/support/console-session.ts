import request from 'supertest';
import { OtpService } from '../../src/platform/identity/otp.service.js';
import { stepAt, totpAt } from '../../src/platform/identity/totp.js';
import type { LoginData } from './sessions.js';
import type { TestApp } from './test-app.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** An authenticator app: holds the secret from the setup link and shows the code for a moment. */
export class Authenticator {
  /** The raw secret bytes, so a test can prove they are stored nowhere. */
  readonly secret: Buffer;

  constructor(base32Secret: string) {
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const char of base32Secret) {
      value = (value << 5) | BASE32.indexOf(char);
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    this.secret = Buffer.from(bytes);
  }

  /** The code at `now`, or at a step before or after it. */
  code(now: Date, stepOffset = 0): string {
    return totpAt(this.secret, stepAt(now) + stepOffset);
  }
}

export interface ConsoleLogin {
  login: LoginData;
  authenticator: Authenticator;
  /** The `Set-Cookie` line that carried the refresh token. */
  cookie: string;
}

/** Asks for a console code, enters it, and returns the answer that carries the `mfaToken`. */
export async function startConsoleSignIn(t: TestApp, email: string) {
  const http = t.app.getHttpServer();
  await request(http).post('/v1/auth/otp').send({ email, clientType: 2 }).expect(202);
  await t.app.get(OtpService).flush();
  const code = t.email.latest(email, 'otp')!.variables!.code as string;
  const res = await request(http)
    .post('/v1/auth/otp/verify')
    .send({ email, code, clientType: 2 })
    .expect(200);
  t.clock.advance(61_000);
  return res.body.data as { mfaRequired: true; mfaToken: string; mfaEnrolled: boolean };
}

/**
 * Signs a Super Admin in to the console end to end: email code, then the
 * authenticator (enrolling one first when none is given). Returns the login
 * data, the authenticator to sign in with next time, and the refresh cookie.
 */
export async function signInConsole(
  t: TestApp,
  email: string,
  authenticator?: Authenticator,
): Promise<ConsoleLogin> {
  const http = t.app.getHttpServer();
  const started = await startConsoleSignIn(t, email);
  let app = authenticator;
  if (!app) {
    const enrol = await request(http)
      .post('/v1/auth/mfa/enrol')
      .send({ mfaToken: started.mfaToken })
      .expect(200);
    app = new Authenticator(enrol.body.data.secret as string);
  }
  const res = await request(http)
    .post('/v1/auth/mfa/verify')
    .send({ mfaToken: started.mfaToken, code: app.code(t.clock.now()) })
    .expect(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
  return { login: res.body.data as LoginData, authenticator: app, cookie };
}
