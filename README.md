# BravyNix School ERP — Backend

The API (and, later, the background worker) for BravyNix School ERP: one modular
NestJS codebase on PostgreSQL, serving the Flutter app and the Super Admin console.

The design documents are the source of truth: PRD, System design (SDD), Database
design (DDD) and API design, kept in the project's `docs/` folder. Section numbers in
code comments point into them.

## Stack

| Concern    | Choice                                                                           |
| ---------- | -------------------------------------------------------------------------------- |
| Runtime    | Node.js 24, TypeScript 6, ES modules                                             |
| Framework  | NestJS 12 (Express)                                                              |
| Database   | PostgreSQL 16, [Kysely](https://kysely.dev) query builder, versioned migrations  |
| Validation | class-validator DTOs; unknown fields are rejected                                |
| Config     | zod-validated environment variables; the app refuses to boot on a bad value      |
| Logging    | pino JSON lines with request IDs and route templates; no URLs, headers or bodies |
| API docs   | OpenAPI generated from the code                                                  |
| Tests      | Vitest (unit, e2e through the full HTTP stack, integration on a real database)   |
| Lint       | oxlint, Prettier, dependency-cruiser for module boundaries                       |

## Getting started

```bash
nvm use                      # Node 24
npm ci
cp .env.example .env
docker compose up -d         # PostgreSQL 16 and Mailpit
npm run db:migrate
npm run db:seed              # "two worlds" test data
npm run start:dev            # http://localhost:3000, OpenAPI UI at /docs
```

Mail sent locally lands in Mailpit at http://localhost:8025.

## Scripts

| Script                                           | What it does                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `start:dev`                                      | Runs the API with reload                                                                   |
| `build`, `start:prod`                            | Compiles to `dist/` and runs it                                                            |
| `test`, `test:cov`                               | Unit tests (`src/**/*.spec.ts`)                                                            |
| `test:e2e`                                       | HTTP tests through the full stack (`test/e2e`)                                             |
| `test:int`                                       | Integration tests on PostgreSQL (`test/integration`)                                       |
| `lint`, `lint:boundaries`, `typecheck`, `format` | Static checks                                                                              |
| `db:migrate`, `db:migrate:down`                  | Applies or rolls back migrations (migration user)                                          |
| `db:seed [scenario]`                             | Writes test data; refused in staging and production                                        |
| `openapi`                                        | Writes `openapi.json`                                                                      |
| `policies`                                       | Writes `policies.json`: every endpoint with its role policy, for QA's authorization matrix |

## Layout

```
src/
├── main.ts                 entry point for the api process
├── app.module.ts           wires every module
├── bootstrap/              HTTP setup shared by main and tests, routes, OpenAPI
├── config/                 environment schema and AppConfig
├── common/                 shared helpers, no business rules (SDD 9.3 rule 6)
│   ├── auth/               role codes, @Policy / @Public, policy guard and registry
│   ├── http/               envelope, error codes, exception filter, guards
│   ├── validation/         validation pipe and field error mapping
│   ├── pagination/         page and cursor helpers
│   ├── time/               Clock (the only source of "now")
│   ├── i18n/               user-facing messages per code, 7 languages
│   └── request-context/    request ID and per-request context
├── platform/               platform modules: database, email; identity, tenancy,
│                           audit, files, notifications and jobs arrive next
├── modules/                business modules, one folder each
├── health/                 /health/live and /health/ready
├── seeds/                  named data sets ("two worlds")
└── cli/                    migrate, seed, openapi, policies
test/
├── e2e/                    full-stack HTTP tests
├── integration/            tests against PostgreSQL
└── support/                test app factory, fixtures, env defaults
```

## Rules every change follows

- **Every endpoint declares `@Policy({ roles, scope, rule })` or `@Public()`.** The app
  refuses to start otherwise (API design 6.4).
- **Every response uses the envelope** `{ success, statusCode, code, message, data, meta,
requestId }`. Return data, or an `ApiResult` for a named code, a 201 or list meta; throw
  `AppException` for errors. Never 204 (API design 7, 8).
- **Never call `new Date()` in business code.** Inject `Clock`; tests use `FixedClock`.
- **Never send email directly.** Inject `EmailSender`; tests read mail from
  `InMemoryEmailSender`. Never log an email body.
- **Writes go through `DatabaseService.transaction(tenant, work)`,** which sets the tenant
  for row-level security and commits the change, its audit entry and its jobs together.
- **Modules talk through `index.ts` only** and own their tables (`npm run lint:boundaries`).
- **Migrations only add**; removing or renaming waits for a later release (SDD 16.6).
- **The app's database user cannot change the schema**; migrations use the migration user.

## Test seams for QA

| Need                 | Seam                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| Read OTP codes       | `EMAIL_DRIVER=memory` → `InMemoryEmailSender.latest(email, 'otp')`              |
| Move time            | Override `Clock` with `FixedClock` (`set`, `advanceMinutes`)                    |
| Authorization matrix | `npm run policies` → `policies.json`; also `x-policy` on each OpenAPI operation |
| Two-tenant data      | `src/seeds/two-worlds.ts` (fixed IDs and `@two-worlds.test` emails)             |
| Real HTTP stack      | `test/support/test-app.ts` → `createTestApp()`                                  |
