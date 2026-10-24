import { Injectable } from '@nestjs/common';
import type { RoleCode } from './roles.js';

/** Who is calling, as read from a verified access token and its live session. */
export interface Principal {
  personId: string;
  sessionId: string;
  roleCode: RoleCode;
  /** Active Society; null for Super Admin and Student / Parent contexts. */
  societyId: string | null;
  clientType: 'mobile' | 'console';
  /** True inside a Super Admin read-only support session (API design 6.7). */
  viaSupportAccess: boolean;
}

/**
 * Verifies a bearer token and re-reads the session (API design 6.1). The
 * Identity module (phase 1) provides the real implementation; until then
 * every token is rejected, so no protected route can be reached.
 */
export abstract class AccessTokenVerifier {
  /** Returns the principal, or throws an `AppException` with a 401 code. */
  abstract verify(token: string): Promise<Principal>;
}

@Injectable()
export class RejectAllAccessTokenVerifier extends AccessTokenVerifier {
  verify(): Promise<Principal> {
    return Promise.reject(new Error('No access token verifier is configured'));
  }
}
