// QA for Phase 1 B3: forged and tampered access tokens, and the signing key setting.
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { SignJWT, UnsecuredJWT } from 'jose';
import { TokenService } from './token.service.js';

const now = new Date('2026-06-01T04:30:00.000Z');
const iat = Math.floor(now.getTime() / 1000);
const claims = {
  personId: '0192a000-0000-7000-8000-000000000001',
  sessionId: '0192a000-0000-7000-8000-000000000002',
  roleCode: 2,
  societyId: null,
  clientType: 'mobile' as const,
};
const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;
const service = new TokenService(pem, 'k1', 'x'.repeat(32));
const body = { sid: claims.sessionId, rol: 2, soc: null, cli: 'mobile' };

function base(jwt: SignJWT) {
  return jwt
    .setSubject(claims.personId)
    .setIssuer('bravynix-school-erp')
    .setAudience('bravynix-school-erp-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900);
}

describe('QA: access tokens', () => {
  it('accepts its own token', async () => {
    const { token } = await service.signAccessToken(claims, now);
    expect((await service.checkAccessToken(token, now)).status).toBe('valid');
  });

  it('refuses alg none', async () => {
    const token = new UnsecuredJWT(body)
      .setSubject(claims.personId)
      .setIssuer('bravynix-school-erp')
      .setAudience('bravynix-school-erp-api')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 900)
      .encode();
    expect(await service.checkAccessToken(token, now)).toEqual({ status: 'invalid' });
  });

  it('refuses HS256 signed with the public key as the secret', async () => {
    const { createPublicKey, createPrivateKey } = await import('node:crypto');
    const publicPem = createPublicKey(createPrivateKey(pem)).export({
      type: 'spki',
      format: 'pem',
    });
    const token = await base(new SignJWT(body).setProtectedHeader({ alg: 'HS256' })).sign(
      new TextEncoder().encode(publicPem as string),
    );
    expect(await service.checkAccessToken(token, now)).toEqual({ status: 'invalid' });
  });

  it('refuses a token from another ES256 key, with the same kid', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const token = await base(
      new SignJWT(body).setProtectedHeader({ alg: 'ES256', kid: 'k1' }),
    ).sign(other);
    expect(await service.checkAccessToken(token, now)).toEqual({ status: 'invalid' });
  });

  it.each([
    ['another issuer', (j: SignJWT) => j.setIssuer('evil')],
    ['another audience', (j: SignJWT) => j.setAudience('bravynix-school-erp-console')],
  ])('refuses %s', async (_name, change) => {
    const signer = new TokenService(pem, 'k1', 'x'.repeat(32));
    const token = await change(
      base(new SignJWT(body).setProtectedHeader({ alg: 'ES256', kid: 'k1' })),
    ).sign((signer as unknown as { privateKey: Parameters<SignJWT['sign']>[0] }).privateKey);
    expect(await service.checkAccessToken(token, now)).toEqual({ status: 'invalid' });
  });

  it('refuses a changed payload and wrong claim types', async () => {
    const { token } = await service.signAccessToken(claims, now);
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>;
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, rol: 1 })).toString('base64url')}.${s}`;
    expect(await service.checkAccessToken(forged, now)).toEqual({ status: 'invalid' });
    const key = (service as unknown as { privateKey: Parameters<SignJWT['sign']>[0] }).privateKey;
    for (const extra of [
      { rol: '1' },
      { rol: 1.5 },
      { sid: undefined },
      { cli: 'admin' },
      { soc: 5 },
    ]) {
      const bad = await base(
        new SignJWT({ ...body, ...extra }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }),
      ).sign(key);
      expect(await service.checkAccessToken(bad, now)).toEqual({ status: 'invalid' });
    }
  });

  it('tells expired from invalid, at the second of expiry', async () => {
    const { token } = await service.signAccessToken(claims, now);
    expect((await service.checkAccessToken(token, new Date(now.getTime() + 899_000))).status).toBe(
      'valid',
    );
    expect(await service.checkAccessToken(token, new Date(now.getTime() + 900_000))).toEqual({
      status: 'expired',
    });
    expect(await service.checkAccessToken('not.a.token', now)).toEqual({ status: 'invalid' });
  });

  it('refuses a signing key that cannot make ES256 tokens when the service is built, not at the first login', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    for (const wrong of [rsa, p384]) {
      expect(() => new TokenService(wrong, 'k1', 'x'.repeat(32))).toThrow(/P-256/);
    }
  });

  it('refresh tokens are random, and stored as an HMAC with the refresh prefix only', () => {
    const a = service.newRefreshToken();
    const b = service.newRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^rt_[\w-]{43}$/);
    expect(
      a.hmac.equals(createHmac('sha256', 'x'.repeat(32)).update(`refresh:${a.token}`).digest()),
    ).toBe(true);
  });
});
