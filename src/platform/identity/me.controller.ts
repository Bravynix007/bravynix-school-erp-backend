import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { ALL_ROLES } from '../../common/auth/roles.js';
import { ContextService, type MeResult } from './context.service.js';

@ApiTags('Me')
@Controller('me')
export class MeController {
  constructor(private readonly contexts: ContextService) {}

  @Policy({
    roles: ALL_ROLES,
    scope: 'self',
    allowNoContext: true,
    allowWhenBlocked: true,
    operationId: 'ME-01',
    rule: "The caller's own profile and contexts",
  })
  @Get()
  me(@CurrentPrincipal() principal: Principal): Promise<MeResult> {
    return this.contexts.me(principal);
  }
}
