import type { RoleCode } from './roles.js';

/** Who is calling, as read from a verified access token and its live session. */
export interface Principal {
  personId: string;
  sessionId: string;
  /** The role the session is acting as; null until a context is chosen (API design 10.2, AUTH-06). */
  roleCode: RoleCode | null;
  /** Active Society; null for Super Admin and Student / Parent contexts. */
  societyId: string | null;
  clientType: 'mobile' | 'console';
  /** True inside a Super Admin read-only support session (API design 6.7). */
  viaSupportAccess: boolean;
}

/**
 * Verifies a bearer token and re-reads the session (API design 6.1). The
 * Identity module provides the implementation.
 */
export abstract class AccessTokenVerifier {
  /** Returns the principal, or throws an `AppException` with a 401 code. */
  abstract verify(token: string): Promise<Principal>;
}
