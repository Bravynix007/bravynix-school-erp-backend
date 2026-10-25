import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { jwtVerify, SignJWT, errors } from 'jose';

/** Access tokens live 15 minutes (API design 6.1, PRD 5.1). */
export const ACCESS_TOKEN_SECONDS = 15 * 60;

const ISSUER = 'bravynix-school-erp';
const AUDIENCE = 'bravynix-school-erp-api';

/**
 * The only claims a token carries (API design 6.1). Clients must not read
 * business data from it, and the API re-reads the session and the grants on
 * every request, so a claim is a hint, never an authority.
 */
export interface AccessClaims {
  personId: string;
  sessionId: string;
  roleCode: number | null;
  societyId: string | null;
  clientType: 'mobile' | 'console';
}

export type AccessTokenCheck =
  { status: 'valid'; claims: AccessClaims } | { status: 'expired' } | { status: 'invalid' };

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

/**
 * Signs and checks access tokens (ES256), and makes refresh tokens. Time
 * comes from the caller, so tests and the clock agree on "now".
 */
export class TokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly hmacKey: Buffer;

  /**
   * @param signingKeyPem PKCS#8 PEM of a P-256 key; a fresh key when absent,
   *   so tokens do not survive a restart (development and tests only).
   * @param keyId named in the token header, for key rotation.
   * @param hmacSecret keys the refresh-token hash.
   */
  constructor(
    signingKeyPem: string | undefined,
    private readonly keyId: string,
    hmacSecret: string | undefined,
  ) {
    if (signingKeyPem) {
      this.privateKey = createPrivateKey(signingKeyPem.replaceAll(String.raw`\n`, '\n'));
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    this.hmacKey = hmacSecret ? Buffer.from(hmacSecret, 'utf8') : randomBytes(32);
  }

  async signAccessToken(claims: AccessClaims, now: Date): Promise<SignedAccessToken> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + ACCESS_TOKEN_SECONDS;
    const token = await new SignJWT({
      sid: claims.sessionId,
      rol: claims.roleCode,
      soc: claims.societyId,
      cli: claims.clientType,
    })
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId, typ: 'JWT' })
      .setSubject(claims.personId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.privateKey);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /** Checks signature, issuer, audience and expiry. Distinguishes expired (refresh) from invalid (sign in again). */
  async checkAccessToken(token: string, now: Date): Promise<AccessTokenCheck> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: ['ES256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: now,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      const { sub, sid, rol, soc, cli } = payload as Record<string, unknown>;
      const clientType = cli === 'mobile' || cli === 'console' ? cli : null;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        clientType === null ||
        !(rol === null || (typeof rol === 'number' && Number.isInteger(rol))) ||
        !(soc === null || typeof soc === 'string')
      ) {
        return { status: 'invalid' };
      }
      return {
        status: 'valid',
        claims: { personId: sub, sessionId: sid, roleCode: rol, societyId: soc, clientType },
      };
    } catch (error) {
      return error instanceof errors.JWTExpired ? { status: 'expired' } : { status: 'invalid' };
    }
  }

  /** A new opaque refresh token: 32 random bytes, shown once, stored only as a hash. */
  newRefreshToken(): { token: string; hmac: Buffer } {
    const token = `rt_${randomBytes(32).toString('base64url')}`;
    return { token, hmac: this.refreshTokenHmac(token) };
  }

  refreshTokenHmac(token: string): Buffer {
    return createHmac('sha256', this.hmacKey).update(`refresh:${token}`).digest();
  }
}
