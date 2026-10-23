import { Global, Module } from '@nestjs/common';
import { parseEnv, type Env } from './env.schema.js';

/**
 * Typed, validated configuration. Inject `AppConfig` instead of reading
 * `process.env`, so tests can hand in their own values.
 */
export abstract class AppConfig {
  abstract readonly env: Env;
}

class EnvAppConfig extends AppConfig {
  constructor(readonly env: Env) {
    super();
  }
}

export function createAppConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  return new EnvAppConfig(parseEnv(source));
}

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => createAppConfig() }],
  exports: [AppConfig],
})
export class AppConfigModule {}
