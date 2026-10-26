import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { RoleShortName, type RoleCode } from './roles.js';

export const POLICY_METADATA = 'auth:policy';

export type TenantScope =
  /** No tenant: login, health, the caller's own profile. */
  | 'none'
  /** Platform-wide; Super Admin only. */
  | 'platform'
  /** The record must sit in the caller's active Society. */
  | 'society'
  /** The record must sit in an Institution of the caller's scope. */
  | 'institution'
  /** The record must belong to one of the caller's linked children. */
  | 'child'
  /** The record must belong to the caller (notes, checklists, devices). */
  | 'self';

export interface RoutePolicy {
  /** `public` endpoints need no access token (OTP request, verify, refresh, health). */
  access: 'public' | 'authenticated';
  /** Roles allowed to call it. Empty for public endpoints. */
  roles: readonly RoleCode[];
  scope: TenantScope;
  /** The fine rule in words, as in the endpoint's spec (API design 6.4 part 3). */
  rule?: string;
  /**
   * Also open to a signed-in session that has not chosen a context yet
   * (logout, switching context, the caller's own profile). Every other
   * endpoint refuses such a session with 403 `FORBIDDEN`.
   */
  allowNoContext?: boolean;
  /**
   * Still answered while the caller's Society is paused (API design 6.5):
   * sign-in and sign-out, the caller's own profile, notifications, and for
   * Society Owners the platform dues. Every other call gets 423 `ACCESS_PAUSED`.
   */
  allowWhenPaused?: boolean;
  /** Catalogue operation ID, e.g. `STU-01`. */
  operationId?: string;
}

function policyDecorator(policy: RoutePolicy) {
  return applyDecorators(
    SetMetadata(POLICY_METADATA, policy),
    ApiExtension('x-policy', {
      access: policy.access,
      roles: policy.roles.map((role) => RoleShortName[role]),
      scope: policy.scope,
      allowNoContext: policy.allowNoContext ?? false,
      allowWhenPaused: policy.allowWhenPaused ?? false,
      rule: policy.rule ?? null,
      operationId: policy.operationId ?? null,
    }),
  );
}

/**
 * Declares who may call an endpoint. Every route must carry `@Policy` or
 * `@Public`; the app refuses to start otherwise (API design 6.4, SDD 13.3).
 * The declarations are exported for QA's endpoint × persona matrix with
 * `npm run policies`.
 */
export function Policy(options: Omit<RoutePolicy, 'access'>) {
  if (options.roles.length === 0) {
    throw new Error('@Policy needs at least one role; use @Public for open endpoints');
  }
  return policyDecorator({ access: 'authenticated', ...options });
}

export function Public(options: { rule?: string; operationId?: string } = {}) {
  return policyDecorator({ access: 'public', roles: [], scope: 'none', ...options });
}
