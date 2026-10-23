# Business modules

One folder per business module from the system design (SDD 9.2), added as
each is built: `academic-setup`, `people`, `attendance`, `timetable`, `diary`,
`exams`, `fees`, `platform-billing`, `events`, `ads`, `announcements`,
`admissions`, `notes`, `ai`.

Each module:

- owns its tables, its migration files and its Kysely types; no other module
  reads or writes them (SDD 9.3 rule 1);
- exposes what other modules may call from its `index.ts` only;
- declares `@Policy` on every endpoint (API design 6.4);
- writes through `DatabaseService.transaction(tenant, ...)` so the business
  change, the audit entry and any jobs commit together (SDD 9.3 rule 4).

`npm run lint:boundaries` enforces the import rules.
