import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppException } from '../http/app-exception.js';
import type { AuthenticatedRequest } from './policy.guard.js';

/**
 * The caller the policy guard resolved. Only for `@Policy` endpoints: on a
 * `@Public` one there is no caller, and asking for it is a programming error.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal) throw AppException.unauthorized();
    return principal;
  },
);
