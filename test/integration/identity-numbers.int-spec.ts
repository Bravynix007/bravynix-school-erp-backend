import { Kysely, PostgresDialect, sql } from 'kysely';
import { AppException } from '../../src/common/http/app-exception.js';
import { newId } from '../../src/common/ids/ids.js';
import { RequestContext } from '../../src/common/request-context/request-context.js';
import { DatabaseService } from '../../src/platform/database/index.js';
import { createPool } from '../../src/platform/database/database.service.js';
import { runMigrations } from '../../src/platform/database/migrator.js';
import {
  IdentityNumbers,
  REVEAL_LIMIT_PER_DAY,
  type IdentitySlot,
} from '../../src/platform/identity-numbers/index.js';
import { readAuditRows } from '../support/audit-rows.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;

/** 10:00 IST on 15 April 2030; the audit partition for the month is made in beforeAll. */
const START = '2030-04-15T04:30:00.000Z';
const NUMBER = '234567890124';

describe('identity numbers: protect and reveal (DDD 15.6, API design 10.9)', () => {
  let ownerDb: Kysely<unknown>;
  let t: TestApp;
  let database: DatabaseService;
  let numbers: IdentityNumbers;
  const societyId = newId();
  const institutionId = newId();

  /** Runs `fn` as an admin of the Society, in one transaction with a request context. */
  const asAdmin = <T>(
    personId: string,
    fn: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<T>,
  ) =>
    RequestContext.run(
      {
        requestId: newId(),
        language: 'en',
        personId,
        societyId,
        roleCode: 3,
        displayName: 'Asha Rao',
      },
      () =>
        database.transaction(
          { personId, societyId, institutionIds: [institutionId], roleCode: 3 },
          fn,
        ),
    );

  const stored = (slot: IdentitySlot) => {
    const { ciphertext, keyVersion } = numbers.protect(NUMBER, slot);
    return { ciphertext, keyVersion };
  };
  const reveal = (admin: string, slot: IdentitySlot, reason = 'Checking the admission form') =>
    asAdmin(admin, (tx) =>
      numbers.reveal(tx, { slot, stored: stored(slot), institutionId, reason }),
    );
  const revealsOf = (admin: string) =>
    readAuditRows<{
      reason: string;
      entity_id: string;
      entity_type: string;
      institution_id: string;
    }>(ownerDb, sql`actor_user_id = ${admin} and action = 'identity.reveal'`);

  beforeAll(async () => {
    await runMigrations(migrationUrl, 'latest');
    ownerDb = new Kysely({
      dialect: new PostgresDialect({ pool: createPool(migrationUrl, 2, 30_000) }),
    });
    await sql`select maintenance.ensure_audit_partitions('2030-04-01', 0)`.execute(ownerDb);
    t = await createTestApp({ clockStart: START });
    database = t.app.get(DatabaseService);
    numbers = t.app.get(IdentityNumbers);
  });

  afterAll(async () => {
    await t.close();
    await ownerDb.destroy();
  });

  it('returns the number it sealed, and writes the audit entry with the reason and the row', async () => {
    const admin = newId();
    const slot: IdentitySlot = { table: 'staff_identities', rowId: newId() };
    expect(await reveal(admin, slot, 'Verifying the offer letter')).toBe(NUMBER);
    const rows = await revealsOf(admin);
    expect(rows).toEqual([
      expect.objectContaining({
        reason: 'Verifying the offer letter',
        entity_type: 'staff_identities',
        entity_id: slot.rowId,
        institution_id: institutionId,
      }),
    ]);
    // The audit row never holds the number or its hash.
    expect(JSON.stringify(rows)).not.toContain(NUMBER);
  });

  it('opens a number only for the row it was sealed for, and writes nothing when it does not open', async () => {
    const admin = newId();
    const slot: IdentitySlot = { table: 'student_identities', rowId: newId() };
    const sealed = stored(slot);
    for (const other of [
      { ...slot, rowId: newId() },
      { ...slot, table: 'staff_identities' as const },
    ]) {
      await expect(
        asAdmin(admin, (tx) =>
          numbers.reveal(tx, {
            slot: other,
            stored: sealed,
            institutionId,
            reason: 'Checking the form',
          }),
        ),
      ).rejects.toThrow('unable to authenticate data');
    }
    expect(await revealsOf(admin)).toHaveLength(0);
  });

  it('refuses a reveal with no reason, no caller, or a key version it does not hold', async () => {
    const admin = newId();
    const slot: IdentitySlot = { table: 'staff_identities', rowId: newId() };
    await expect(reveal(admin, slot, 'short')).rejects.toThrow(/reason/);
    await expect(reveal(admin, slot, ' '.repeat(20))).rejects.toThrow(/reason/);
    await expect(
      database.transaction({ societyId, institutionIds: [institutionId] }, (tx) =>
        numbers.reveal(tx, {
          slot,
          stored: stored(slot),
          institutionId,
          reason: 'Checking the form',
        }),
      ),
    ).rejects.toThrow(/caller/);
    await expect(
      asAdmin(admin, (tx) =>
        numbers.reveal(tx, {
          slot,
          stored: { ...stored(slot), keyVersion: 2 },
          institutionId,
          reason: 'Checking the form',
        }),
      ),
    ).rejects.toThrow(/version 2/);
    expect(await revealsOf(admin)).toHaveLength(0);
  });

  it('allows 10 reveals an IST day for each admin, then 429 REVEAL_LIMIT until midnight IST', async () => {
    const admin = newId();
    const other = newId();
    const slot: IdentitySlot = { table: 'staff_identities', rowId: newId() };
    for (let i = 0; i < REVEAL_LIMIT_PER_DAY; i++) await reveal(admin, slot);

    const refused = await reveal(admin, slot).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppException);
    expect(refused).toMatchObject({ status: 429, code: 'REVEAL_LIMIT' });
    // 10:00 IST, so 14 hours to midnight.
    expect((refused as AppException).options.retryAfterSeconds).toBe(14 * 3600);
    expect(await revealsOf(admin)).toHaveLength(REVEAL_LIMIT_PER_DAY);

    // Another admin is not held back by this one.
    expect(await reveal(other, slot)).toBe(NUMBER);

    // Just before midnight IST the limit still holds; just after, a new day starts.
    t.clock.set('2030-04-15T18:29:00.000Z');
    await expect(reveal(admin, slot)).rejects.toMatchObject({ code: 'REVEAL_LIMIT' });
    t.clock.set('2030-04-15T18:31:00.000Z');
    expect(await reveal(admin, slot)).toBe(NUMBER);
    t.clock.set(START);
  });

  it('counts reveals made at the same moment, so a burst cannot pass the limit', async () => {
    const admin = newId();
    const slot: IdentitySlot = { table: 'student_identities', rowId: newId() };
    const results = await Promise.allSettled(
      Array.from({ length: REVEAL_LIMIT_PER_DAY + 4 }, () => reveal(admin, slot)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(REVEAL_LIMIT_PER_DAY);
    expect(await revealsOf(admin)).toHaveLength(REVEAL_LIMIT_PER_DAY);
  });
});
