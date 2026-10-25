import { generateKeyPairSync } from 'node:crypto';
import { decodeProtectedHeader, SignJWT } from 'jose';
import { ACCESS_TOKEN_SECONDS, TokenService, type AccessClaims } from './token.service.js';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const after = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const claims: AccessClaims = {
  personId: '0192b0e0-0000-7000-8000-000000000001',
  sessionId: '0192b0e0-0000-7000-8000-000000000002',
  roleCode: 3,
  societyId: '0192b0e0-0000-7000-8000-000000000003',
  clientType: 'mobile',
};

describe('TokenService access tokens', () => {
  const service = new TokenService(undefined, 'k1', 'x'.repeat(32));

  it('carries exactly the five claims, and expires after 15 minutes', async () => {
    const { token, expiresAt } = await service.signAccessToken(claims, NOW);
    expect(expiresAt).toEqual(after(900));
    expect(ACCESS_TOKEN_SECONDS).toBe(900);
    expect(await service.checkAccessToken(token, after(899))).toEqual({
      status: 'valid',
      claims,
    });
    expect(await service.checkAccessToken(token, after(900))).toEqual({ status: 'expired' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).toSorted()).toEqual(
      ['aud', 'cli', 'exp', 'iat', 'iss', 'rol', 'soc', 'sid', 'sub'].toSorted(),
    );
  });

  it('names the key and the algorithm in the header', async () => {
    const { token } = await service.signAccessToken(claims, NOW);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: 'k1', typ: 'JWT' });
  });

  it('carries no role or Society before a context is chosen', async () => {
    const bare = { ...claims, roleCode: null, societyId: null };
    const { token } = await service.signAccessToken(bare, NOW);
    expect(await service.checkAccessToken(token, NOW)).toEqual({ status: 'valid', claims: bare });
  });

  it('rejects a token signed by another key, a changed payload, and garbage', async () => {
    const other = new TokenService(undefined, 'k1', undefined);
    const foreign = (await other.signAccessToken(claims, NOW)).token;
    expect(await service.checkAccessToken(foreign, NOW)).toEqual({ status: 'invalid' });

    const { token } = await service.signAccessToken(claims, NOW);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'someone-else' })).toString(
      'base64url',
    );
    expect(await service.checkAccessToken(`${header}.${forged}.${signature}`, NOW)).toEqual({
      status: 'invalid',
    });
    for (const junk of ['', 'abc', 'a.b.c', `${token}x`]) {
      expect(await service.checkAccessToken(junk, NOW)).toEqual({ status: 'invalid' });
    }
  });

  it('rejects an unsigned token and one using another algorithm', async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      '{"sub":"x","exp":9999999999,"iat":1}',
    ).toString('base64url')}.`;
    expect(await service.checkAccessToken(unsigned, NOW)).toEqual({ status: 'invalid' });
    const hs = await new SignJWT({ sid: 's', rol: 1, soc: null, cli: 'mobile' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('p')
      .setIssuer('bravynix-school-erp')
      .setAudience('bravynix-school-erp-api')
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 900)
      .sign(new TextEncoder().encode('x'.repeat(32)));
    expect(await service.checkAccessToken(hs, NOW)).toEqual({ status: 'invalid' });
  });

  it('rejects a token for another audience or issuer', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const mine = new TokenService(pem, 'k1', undefined);
    const issued = Math.floor(NOW.getTime() / 1000);
    const wrong = await new SignJWT({ sid: 's', rol: 1, soc: null, cli: 'mobile' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('p')
      .setIssuer('someone-else')
      .setAudience('bravynix-school-erp-api')
      .setIssuedAt(issued)
      .setExpirationTime(issued + 900)
      .sign(pair.privateKey);
    expect(await mine.checkAccessToken(wrong, NOW)).toEqual({ status: 'invalid' });
  });

  it('rejects a token with a claim of the wrong shape', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const mine = new TokenService(pem, 'k1', undefined);
    const issued = Math.floor(NOW.getTime() / 1000);
    const odd = await new SignJWT({ sid: 's', rol: 'admin', soc: null, cli: 'mobile' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('p')
      .setIssuer('bravynix-school-erp')
      .setAudience('bravynix-school-erp-api')
      .setIssuedAt(issued)
      .setExpirationTime(issued + 900)
      .sign(pair.privateKey);
    expect(await mine.checkAccessToken(odd, NOW)).toEqual({ status: 'invalid' });
  });

  it('loads a PEM key, with \\n escapes for a single-line variable', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const a = new TokenService(pem, 'k1', undefined);
    const b = new TokenService(pem.replaceAll('\n', String.raw`\n`), 'k1', undefined);
    const { token } = await a.signAccessToken(claims, NOW);
    expect((await b.checkAccessToken(token, NOW)).status).toBe('valid');
  });
});

describe('TokenService refresh tokens', () => {
  const service = new TokenService(undefined, 'k1', 'x'.repeat(32));

  it('makes long random tokens that are stored as 32-byte hashes', () => {
    const a = service.newRefreshToken();
    const b = service.newRefreshToken();
    expect(a.token).toMatch(/^rt_[\w-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hmac).toHaveLength(32);
    expect(service.refreshTokenHmac(a.token).equals(a.hmac)).toBe(true);
    expect(service.refreshTokenHmac(b.token).equals(a.hmac)).toBe(false);
  });

  it('hashes differently under another secret', () => {
    const other = new TokenService(undefined, 'k1', 'y'.repeat(32));
    const { token, hmac } = service.newRefreshToken();
    expect(other.refreshTokenHmac(token).equals(hmac)).toBe(false);
  });
});
