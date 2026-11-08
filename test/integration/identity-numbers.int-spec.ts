import { createHmac } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { AppException } from '../../src/common/http/app-exception.js';
import { newId } from '../../src/common/ids/ids.js';
import { RequestContext } from '../../src/common/request-context/request-context.js';
import { AuditService } from '../../src/platform/audit/index.js';
import { SecretBox } from '../../src/platform/crypto/index.js';
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

  /** Where a call is made: a Society and the one Institution of it the request is narrowed to. */
  interface Place {
    societyId: string;
    institutionId: string;
  }
  const here: Place = { societyId, institutionId };

  /** Runs `fn` as an admin in that place, in one transaction with a request context. */
  const asAdmin = <T>(
    personId: string,
    fn: (tx: Parameters<Parameters<DatabaseService['transaction']>[1]>[0]) => Promise<T>,
    place: Place = here,
  ) =>
    RequestContext.run(
      {
        requestId: newId(),
        language: 'en',
        personId,
        societyId: place.societyId,
        roleCode: 3,
        displayName: 'Asha Rao',
      },
      () =>
        database.transaction(
          {
            personId,
            societyId: place.societyId,
            institutionIds: [place.institutionId],
            roleCode: 3,
          },
          fn,
        ),
    );

  const stored = (slot: IdentitySlot) => {
    const { ciphertext, keyVersion } = numbers.protect(NUMBER, slot);
    return { ciphertext, keyVersion };
  };
  const reveal = (
    admin: string,
    slot: IdentitySlot,
    reason = 'Checking the admission form',
    place: Place = here,
  ) =>
    asAdmin(
      admin,
      (tx) =>
        numbers.reveal(tx, {
          slot,
          stored: stored(slot),
          institutionId: place.institutionId,
          reason,
        }),
      place,
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
    for (const [reason, code] of [
      ['short', 'TOO_SHORT'],
      ['abc' + ' '.repeat(7), 'TOO_SHORT'],
      [' '.repeat(20), 'TOO_SHORT'],
      ['x'.repeat(501), 'TOO_LONG'],
    ] as const) {
      await expect(reveal(admin, slot, reason)).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        options: { errors: [expect.objectContaining({ field: 'reason', code })] },
      });
    }
    expect(await reveal(admin, slot, 'x'.repeat(500))).toBe(NUMBER);
    expect(await reveal(admin, slot, '  ten chars!  ')).toBe(NUMBER);
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
    // A request that has its caller but whose tenant does not name them cannot be counted, so it is refused.
    await expect(
      RequestContext.run({ requestId: newId(), language: 'en', personId: admin, societyId }, () =>
        database.transaction({ societyId, institutionIds: [institutionId] }, (tx) =>
          numbers.reveal(tx, {
            slot,
            stored: stored(slot),
            institutionId,
            reason: 'Checking the form',
          }),
        ),
      ),
    ).rejects.toThrow(/tenant person/);
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
    expect(await revealsOf(admin)).toHaveLength(2);
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

  it('counts the reveals of an admin across Institutions and Societies, however the request is narrowed', async () => {
    const admin = newId();
    const slot: IdentitySlot = { table: 'staff_identities', rowId: newId() };
    const second: Place = { societyId, institutionId: newId() };
    const other: Place = { societyId: newId(), institutionId: newId() };
    for (let i = 0; i < REVEAL_LIMIT_PER_DAY - 2; i++) await reveal(admin, slot);
    await reveal(admin, slot, 'Checking the form', second);
    await reveal(admin, slot, 'Checking the form', other);
    for (const place of [here, second, other]) {
      await expect(reveal(admin, slot, 'Checking the form', place)).rejects.toMatchObject({
        status: 429,
        code: 'REVEAL_LIMIT',
      });
    }
    expect(await revealsOf(admin)).toHaveLength(REVEAL_LIMIT_PER_DAY);
  });

  it('counts only reveals: an admin with other entries today can still reveal', async () => {
    const admin = newId();
    const slot: IdentitySlot = { table: 'staff_identities', rowId: newId() };
    const audit = t.app.get(AuditService);
    for (let i = 0; i < REVEAL_LIMIT_PER_DAY + 2; i++) {
      await asAdmin(admin, (tx) =>
        audit.record(tx, { action: 'student.update', institutionId, societyId }),
      );
    }
    expect(await reveal(admin, slot)).toBe(NUMBER);
  });

  it('shows a person their own reveals and nothing of anyone else’s, whoever reads and wherever', async () => {
    const x = newId();
    const y = newId();
    const slot: IdentitySlot = { table: 'staff_identities', rowId: newId() };
    const audit = t.app.get(AuditService);
    const secondInstitution: Place = { societyId, institutionId: newId() };
    const otherSociety: Place = { societyId: newId(), institutionId: newId() };
    await reveal(x, slot);
    await asAdmin(x, (tx) =>
      audit.record(tx, { action: 'student.update', institutionId, societyId }),
    );
    await reveal(y, slot, 'Checking the form', otherSociety);
    await reveal(y, slot, 'Checking the form', secondInstitution);

    /** What `reader` sees, as the application role, of the rows `actor` made. */
    const seen = (reader: string | undefined, place: Place, actor: string) =>
      database.transaction(
        {
          ...(reader === undefined ? {} : { personId: reader }),
          societyId: place.societyId,
          institutionIds: [place.institutionId],
          roleCode: 3,
        },
        async (tx) =>
          (
            await sql<{ action: string }>`
              select action from audit_logs where actor_user_id = ${actor} order by action
            `.execute(tx)
          ).rows.map((row) => row.action),
      );

    // Nobody else reads X's reveal: not another person in another Society or at another Institution, not a tenant
    // that names no person.
    expect(await seen(y, otherSociety, x)).toEqual([]);
    expect(await seen(y, secondInstitution, x)).toEqual([]);
    expect(await seen(undefined, otherSociety, x)).toEqual([]);
    expect(await seen(undefined, secondInstitution, x)).toEqual([]);
    // X reads the reveal from another Society too, and none of X's other entries there.
    expect(await seen(x, otherSociety, x)).toEqual(['identity.reveal']);
    expect(await seen(x, secondInstitution, x)).toEqual(['identity.reveal']);
    // Y's reveals stay Y's: X, in a Society where Y never acted, reads none of them.
    expect(await seen(x, { societyId: newId(), institutionId: newId() }, y)).toEqual([]);
  });

  it('seals with IDENTITY_ENCRYPTION_KEY and hashes with IDENTITY_HMAC_KEY, as the settings name them', () => {
    const slot: IdentitySlot = { table: 'student_identities', rowId: newId() };
    const protectedNumber = numbers.protect(NUMBER, slot);
    // An independent box and hash from the settings: the app's output must match them, not its own key.
    const box = new SecretBox(process.env.IDENTITY_ENCRYPTION_KEY, 'IDENTITY_ENCRYPTION_KEY');
    expect(
      box.open(protectedNumber.ciphertext, `student_identities.aadhaar:${slot.rowId}`).toString(),
    ).toBe(NUMBER);
    const hmac = createHmac('sha256', Buffer.from(process.env.IDENTITY_HMAC_KEY!, 'base64'));
    expect(protectedNumber.hmac.equals(hmac.update(NUMBER).digest())).toBe(true);
    // The two keys are not the same key.
    expect(process.env.IDENTITY_ENCRYPTION_KEY).not.toBe(process.env.IDENTITY_HMAC_KEY);
    const swapped = new SecretBox(process.env.IDENTITY_HMAC_KEY, 'IDENTITY_HMAC_KEY');
    expect(() =>
      swapped.open(protectedNumber.ciphertext, `student_identities.aadhaar:${slot.rowId}`),
    ).toThrow();
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
