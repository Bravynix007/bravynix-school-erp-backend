import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE, DiscoveryModule } from '@nestjs/core';
import { AccessTokenVerifier, RejectAllAccessTokenVerifier } from './auth/access-token-verifier.js';
import { PolicyGuard } from './auth/policy.guard.js';
import { PolicyRegistry } from './auth/policy-registry.js';
import { AllExceptionsFilter } from './http/all-exceptions.filter.js';
import { AppVersionGuard } from './http/app-version.guard.js';
import { ContentTypeGuard } from './http/content-type.guard.js';
import { ResponseEnvelopeInterceptor } from './http/response-envelope.interceptor.js';
import { Clock, SystemClock } from './time/clock.js';
import { createValidationPipe, TrimStringsPipe } from './validation/validation.js';

/**
 * Cross-cutting pieces every request goes through, in this order:
 * content type → app version → policy (guards), trim → validate (pipes),
 * envelope (interceptor), and the error envelope (filter).
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: AccessTokenVerifier, useClass: RejectAllAccessTokenVerifier },
    PolicyRegistry,
    // Order matters: a client too old to work gets 426 first, then who is
    // calling (401/403) is settled before what they sent (415).
    { provide: APP_GUARD, useClass: AppVersionGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
    { provide: APP_GUARD, useClass: ContentTypeGuard },
    { provide: APP_PIPE, useClass: TrimStringsPipe },
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [Clock, AccessTokenVerifier, PolicyRegistry],
})
export class CommonModule {}
