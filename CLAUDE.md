# Notes for AI assistants working in this repo

Read `README.md` first; its "Rules every change follows" section is binding.

- Design docs (PRD, SDD, DDD, API design) are the source of truth. Code comments cite
  their sections, e.g. "API design 6.4". When code and docs disagree, raise it; don't guess.
- ES modules: relative imports end in `.js` even for `.ts` files.
- New endpoint checklist: DTO with class-validator, `@Policy` or `@Public`, envelope via
  return value or `ApiResult`, errors via `AppException` with a stable code, unit tests for
  rules, an e2e or integration test for the endpoint.
- Body DTOs never carry `@Type(() => Number)` or any other transform of a primitive: JSON
  already has types, and a converted `"5"` would pass where the contract wants 400
  `INVALID_TYPE` (API design 12.1). Query DTOs do need it, because query values are strings.
- New table checklist: migration file in the owning module, registered in
  `src/platform/database/migrations/index.ts`; standard columns (DDD 5.2); `society_id` /
  `institution_id` on tenant rows; row-level security policy using `app_current_*()`;
  Kysely types; seed rows in `src/seeds/two-worlds.ts` writers.
- Never commit secrets, real personal data or seeded passwords. Login is email OTP only.
- Before pushing: `npm run format:check && npm run lint && npm run lint:boundaries &&
npm run typecheck && npm test && npm run test:e2e && npm run test:int`.
