import { reportedStatus, userTypeFor } from './auth-codes.js';
import type { Context } from './contexts.js';
import type { LoginUser } from './identity.repository.js';
import type { SignedAccessToken } from './token.service.js';

/** What AUTH-02 and AUTH-04 return on a signed-in session (API design 10.2). */
export interface LoginResult {
  userType: number | null;
  userTypeName: string | null;
  accessToken: string;
  accessTokenExpiresAt: string;
  /** Null on the console, which receives it as a cookie. */
  refreshToken: string | null;
  session: { id: string; activeContext: Context | null };
  person: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    preferredLanguage: string;
    accountStatus: number;
  };
  contexts: Context[];
  requiredNotices: never[];
}

export function buildLoginResult(input: {
  user: LoginUser;
  sessionId: string;
  contexts: Context[];
  active: Context | null;
  accessToken: SignedAccessToken;
  refreshToken: string | null;
}): LoginResult {
  const { user, active } = input;
  return {
    ...userTypeFor(active?.roleCode ?? null),
    accessToken: input.accessToken.token,
    accessTokenExpiresAt: input.accessToken.expiresAt.toISOString(),
    refreshToken: input.refreshToken,
    session: {
      id: input.sessionId,
      activeContext: active ? { roleCode: active.roleCode, societyId: active.societyId } : null,
    },
    person: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      preferredLanguage: user.preferredLanguage,
      accountStatus: reportedStatus(user.accountStatus),
    },
    contexts: input.contexts,
    requiredNotices: [],
  };
}

/** The name the audit log shows for a person. */
export function displayName(user: LoginUser): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || null;
}
