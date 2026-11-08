import { randomBytes } from 'node:crypto';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { RequestContext } from '../../common/request-context/request-context.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditEntry, AuditService } from '../audit/index.js';
import { SecretBox } from '../crypto/index.js';
import type { Tx } from '../database/index.js';
import {
  IdentityNumbers,
  requireRevealReason,
  type IdentitySlot,
} from './identity-numbers.service.js';

const NUMBER = '234567890124';
const slot: IdentitySlot = { table: 'staff_identities', rowId: 'staff-1' };
const REASON = 'Checking the offer letter';

/** A Kysely over a driver that answers by the SQL text, so the reveal's own queries run without a database. */
function fakeTx(answer: (sql: string) => Record<string, unknown>[]): { tx: Tx; seen: string[] } {
  const seen: string[] = [];
  class Driver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(query: { sql: string }): Promise<QueryResult<R>> {
          seen.push(query.sql);
          return Promise.resolve({ rows: answer(query.sql) as R[] });
        },
        // eslint-disable-next-line require-yield
        async *streamQuery() {
          await Promise.resolve();
        },
      });
    }
  }
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { tx: db as unknown as Tx, seen };
}

function build(options: { person?: string | null; count?: number } = {}) {
  const person = options.person === undefined ? 'admin-1' : options.person;
  const record = vi
    .fn<(tx: Tx, entry: AuditEntry) => Promise<string>>()
    .mockResolvedValue('audit-1');
  const clock = new FixedClock('2030-04-15T04:30:00.000Z');
  const box = new SecretBox(randomBytes(32).toString('base64'), 'IDENTITY_ENCRYPTION_KEY');
  const numbers = new IdentityNumbers(
    box,
    randomBytes(32),
    { record } as unknown as AuditService,
    clock,
  );
  const { tx, seen } = fakeTx((text) => {
    if (text.includes('app_current_person_id')) return [{ person }];
    if (text.includes('count(')) return [{ count: String(options.count ?? 0) }];
    return [];
  });
  const stored = numbers.protect(NUMBER, slot);
  const reveal = (reason = REASON, as: string | null = 'admin-1') =>
    as === null
      ? numbers.reveal(tx, { slot, stored, institutionId: 'institution-1', reason })
      : RequestContext.run({ requestId: 'r-1', language: 'en', personId: as }, () =>
          numbers.reveal(tx, { slot, stored, institutionId: 'institution-1', reason }),
        );
  return { numbers, record, reveal, seen, stored, tx };
}

describe('IdentityNumbers.reveal', () => {
  it('returns the number after the audit entry is written, with the trimmed reason and the row', async () => {
    const t = build();
    expect(await t.reveal(`  ${REASON}  `)).toBe(NUMBER);
    expect(t.record).toHaveBeenCalledWith(t.tx, {
      action: 'identity.reveal',
      entityType: 'staff_identities',
      entityId: 'staff-1',
      institutionId: 'institution-1',
      reason: REASON,
    });
    expect(t.seen.some((text) => text.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('answers 429 REVEAL_LIMIT with the seconds to midnight IST when ten were already made today, and records nothing', async () => {
    const t = build({ count: 10 });
    await expect(t.reveal()).rejects.toMatchObject({
      status: 429,
      code: 'REVEAL_LIMIT',
      options: { retryAfterSeconds: 14 * 3600 },
    });
    expect(t.record).not.toHaveBeenCalled();
  });

  it('allows the tenth reveal when nine were made', async () => {
    expect(await build({ count: 9 }).reveal()).toBe(NUMBER);
  });

  it('refuses a caller the tenant does not name, so the count cannot silently be zero', async () => {
    await expect(build({ person: null }).reveal()).rejects.toThrow(/tenant person/);
    await expect(build({ person: 'someone-else' }).reveal()).rejects.toThrow(/tenant person/);
  });

  it('refuses a request with no caller and a number sealed with a key version it does not hold', async () => {
    await expect(build().reveal(REASON, null)).rejects.toThrow(/signed-in caller/);
    const t = build();
    await expect(
      RequestContext.run({ requestId: 'r-1', language: 'en', personId: 'admin-1' }, () =>
        t.numbers.reveal(t.tx, {
          slot,
          stored: { ...t.stored, keyVersion: 2 },
          institutionId: 'institution-1',
          reason: REASON,
        }),
      ),
    ).rejects.toThrow(/version 2/);
  });

  it('does not open a number sealed for another row', async () => {
    const t = build();
    await expect(
      RequestContext.run({ requestId: 'r-1', language: 'en', personId: 'admin-1' }, () =>
        t.numbers.reveal(t.tx, {
          slot: { ...slot, rowId: 'staff-2' },
          stored: t.stored,
          institutionId: 'institution-1',
          reason: REASON,
        }),
      ),
    ).rejects.toThrow('unable to authenticate data');
    expect(t.record).not.toHaveBeenCalled();
  });
});

describe('requireRevealReason', () => {
  it('trims and takes 10 to 500 characters', () => {
    expect(requireRevealReason(`  ${REASON}\n`)).toBe(REASON);
    expect(requireRevealReason('x'.repeat(10))).toHaveLength(10);
    expect(requireRevealReason('x'.repeat(500))).toHaveLength(500);
  });

  it.each([
    ['', 'TOO_SHORT', { min: 10 }],
    ['abc       ', 'TOO_SHORT', { min: 10 }],
    ['x'.repeat(9), 'TOO_SHORT', { min: 10 }],
    ['x'.repeat(501), 'TOO_LONG', { max: 500 }],
  ])('refuses %j with 400 VALIDATION_FAILED on reason', (reason, code, params) => {
    expect(() => requireRevealReason(reason)).toThrow(
      expect.objectContaining({
        status: 400,
        code: 'VALIDATION_FAILED',
        options: { errors: [expect.objectContaining({ field: 'reason', code, params })] },
      }) as Error,
    );
  });
});
