import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../http/app-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { RequestContext } from '../request-context/request-context.js';
import { AccessTokenVerifier, type Principal } from './access-token-verifier.js';
import { POLICY_METADATA, type RoutePolicy } from './policy.decorator.js';

export type AuthenticatedRequest = Request & { principal?: Principal };

/** A support session may only read (API design 6.7). */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Check 1 of 3 on every request (API design 6.4): is there a valid session,
 * and may the active role call this endpoint at all? Tenant scope (check 2)
 * and the fine rule (check 3) run in the module's service, where the record
 * is known, and again in the database through row-level security.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AccessTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const policy = this.reflector.getAllAndOverride<RoutePolicy | undefined>(POLICY_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    // The registry refuses to boot without a policy; deny if one slips through.
    if (!policy) throw AppException.forbidden();
    if (policy.access === 'public') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.bearerToken(request);
    if (!token) throw AppException.unauthorized(ErrorCode.TOKEN_INVALID);

    let principal: Principal;
    try {
      principal = await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof AppException) throw error;
      throw AppException.unauthorized(ErrorCode.TOKEN_INVALID);
    }

    if (!policy.roles.includes(principal.roleCode)) throw AppException.forbidden();
    if (principal.viaSupportAccess && !SAFE_METHODS.has(request.method)) {
      throw AppException.forbidden(ErrorCode.SUPPORT_READ_ONLY);
    }

    request.principal = principal;
    const ctx = RequestContext.current();
    if (ctx) {
      ctx.personId = principal.personId;
      ctx.societyId = principal.societyId ?? undefined;
      ctx.roleCode = principal.roleCode;
    }
    return true;
  }

  /** Exactly `Bearer <token>`; anything else is no token at all. */
  private bearerToken(request: Request): string | null {
    const match = /^Bearer ([^\s]+)$/i.exec(request.header('authorization') ?? '');
    return match?.[1] ?? null;
  }
}
