import { HttpStatus } from '@nestjs/common';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { DatabaseService, Tx } from '../database/index.js';
import { IDEMPOTENCY_TTL_MS, fingerprintOf } from './idempotency.rules.js';
import type { IdempotencyRepository, StoredAnswer } from './idempotency.repository.js';
import { IdempotencyService, type IdempotentCall } from './idempotency.service.js';

const now = '2026-11-01T10:00:00.000Z';
const key = '00000000-0000-4000-8000-000000000001';
const tx = {} as Tx;

const call = (overrides: Partial<IdempotentCall> = {}): IdempotentCall => ({
  tenant: { roleCode: 1, personId: 'person-1' },
  key,
  operation: 'billing.raise_due',
  request: { institutionId: 'inst-1' },
  ...overrides,
});

const answer = (overrides: Partial<StoredAnswer> = {}): StoredAnswer => ({
  user_id: 'person-1',
  idempotency_key: key,
  operation: 'billing.raise_due',
  request_fingerprint: fingerprintOf('billing.raise_due', { institutionId: 'inst-1' }),
  response_status: 201,
  response_body: { code: 'CREATED', data: { invoiceNo: 'BNX/FY2026-27/0007' }, meta: null },
  resource_id: 'due-1',
  created_at: new Date(now),
  expires_at: new Date(new Date(now).getTime() + IDEMPOTENCY_TTL_MS),
  ...overrides,
});

function build(options: { claimed?: boolean; stored?: StoredAnswer } = {}) {
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const claim = vi.fn<IdempotencyRepository['claim']>().mockResolvedValue(options.claimed ?? true);
  const find = vi.fn<IdempotencyRepository['find']>().mockResolvedValue(options.stored);
  const insert = vi.fn<IdempotencyRepository['insert']>().mockResolvedValue();
  const remove = vi.fn<IdempotencyRepository['remove']>().mockResolvedValue();
  const removeExpired = vi.fn<IdempotencyRepository['removeExpired']>().mockResolvedValue(3);
  const service = new IdempotencyService(
    { transaction } as unknown as DatabaseService,
    { claim, find, insert, remove, removeExpired } as unknown as IdempotencyRepository,
    new FixedClock(now),
  );
  return { service, transaction, claim, find, insert, remove, removeExpired };
}

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const created = () =>
  Promise.resolve({
    result: ApiResult.created({ invoiceNo: 'BNX/FY2026-27/0007' }),
    resourceId: 'due-1',
  });

describe('IdempotencyService.run', () => {
  describe('the first request', () => {
    it('runs the work and stores its answer in the same transaction, for 24 hours', async () => {
      const t = build();
      const work = vi.fn<typeof created>(created);
      const result = await t.service.run(call(), work);
      expect(work).toHaveBeenCalledWith(tx);
      expect(result.options.status).toBe(HttpStatus.CREATED);
      expect(result.options.headers).toBeUndefined();
      expect(t.transaction).toHaveBeenCalledTimes(1);
      const row = t.insert.mock.calls[0]![1];
      expect(row).toMatchObject({
        user_id: 'person-1',
        idempotency_key: key,
        operation: 'billing.raise_due',
        response_status: 201,
        resource_id: 'due-1',
        created_at: new Date(now),
        expires_at: new Date('2026-11-02T10:00:00.000Z'),
      });
      expect(JSON.parse(row.response_body as string)).toEqual({
        code: 'CREATED',
        data: { invoiceNo: 'BNX/FY2026-27/0007' },
        meta: null,
      });
    });

    it('refuses a missing or malformed key before it opens a transaction', async () => {
      const t = build();
      const work = vi.fn<typeof created>(created);
      expect((await refusal(t.service.run(call({ key: undefined }), work))).code).toBe(
        'IDEMPOTENCY_KEY_REQUIRED',
      );
      expect((await refusal(t.service.run(call({ key: 'nope' }), work))).code).toBe(
        'VALIDATION_FAILED',
      );
      expect(t.transaction).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
    });

    it('stores nothing when the work fails with something that can change', async () => {
      const t = build();
      for (const error of [
        new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED'),
        new AppException(HttpStatus.FORBIDDEN, 'FORBIDDEN'),
        new Error('database down'),
      ]) {
        await expect(t.service.run(call(), () => Promise.reject(error))).rejects.toBe(error);
      }
      expect(t.insert).not.toHaveBeenCalled();
      expect(t.transaction).toHaveBeenCalledTimes(3);
    });

    it('stores a 409 or 422 refusal in a transaction of its own, after the work rolled back', async () => {
      const t = build();
      const error = new AppException(HttpStatus.UNPROCESSABLE_ENTITY, 'NO_RATE_IN_FORCE', {
        message: 'No rate',
        errors: [{ field: 'periodStartDate', code: 'NO_RATE_IN_FORCE', message: 'x' }],
      });
      await expect(t.service.run(call(), () => Promise.reject(error))).rejects.toBe(error);
      expect(t.transaction).toHaveBeenCalledTimes(2);
      const row = t.insert.mock.calls[0]![1];
      expect(row.response_status).toBe(422);
      expect(JSON.parse(row.response_body as string)).toMatchObject({
        refusal: true,
        code: 'NO_RATE_IN_FORCE',
        message: 'No rate',
      });
    });

    it('still raises the refusal when storing it fails or the first request is still running', async () => {
      const failing = build();
      failing.insert.mockRejectedValue(new Error('disk full'));
      const error = new AppException(HttpStatus.CONFLICT, 'DUPLICATE');
      await expect(failing.service.run(call(), () => Promise.reject(error))).rejects.toBe(error);

      const busy = build();
      busy.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(busy.service.run(call(), () => Promise.reject(error))).rejects.toBe(error);
      expect(busy.insert).not.toHaveBeenCalled();
    });
  });

  describe('a repeat', () => {
    it('sends the stored success again, runs nothing, and says it was replayed', async () => {
      const t = build({ stored: answer() });
      const work = vi.fn<typeof created>(created);
      const result = await t.service.run(call(), work);
      expect(work).not.toHaveBeenCalled();
      expect(t.insert).not.toHaveBeenCalled();
      expect(result.data).toEqual({ invoiceNo: 'BNX/FY2026-27/0007' });
      expect(result.options).toMatchObject({
        status: 201,
        code: 'CREATED',
        headers: { 'Idempotent-Replayed': 'true' },
      });
    });

    it('sends a stored refusal again as the same refusal, and does not store it twice', async () => {
      const t = build({
        stored: answer({
          response_status: 409,
          response_body: { refusal: true, code: 'DUPLICATE', errors: [{ field: 'x' }] },
        }),
      });
      const error = await refusal(t.service.run(call(), vi.fn<typeof created>(created)));
      expect([error.status, error.code, error.options.errors]).toEqual([
        409,
        'DUPLICATE',
        [{ field: 'x' }],
      ]);
      expect(t.transaction).toHaveBeenCalledTimes(1);
    });

    it('answers 422 IDEMPOTENCY_KEY_REUSED for another request or another operation, and never stores that', async () => {
      const t = build({ stored: answer() });
      const other = await refusal(
        t.service.run(
          call({ request: { institutionId: 'inst-2' } }),
          vi.fn<typeof created>(created),
        ),
      );
      expect([other.status, other.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
      const operation = await refusal(
        t.service.run(call({ operation: 'fees.record_payment' }), vi.fn<typeof created>(created)),
      );
      expect(operation.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(t.insert).not.toHaveBeenCalled();
      expect(t.transaction).toHaveBeenCalledTimes(2);
    });

    it('answers 409 IDEMPOTENCY_IN_PROGRESS with Retry-After 1 while the first still runs, and never stores that', async () => {
      const t = build({ claimed: false });
      const work = vi.fn<typeof created>(created);
      const error = await refusal(t.service.run(call(), work));
      expect([error.status, error.code, error.options.retryAfterSeconds]).toEqual([
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        1,
      ]);
      expect(work).not.toHaveBeenCalled();
      expect(t.find).not.toHaveBeenCalled();
      expect(t.transaction).toHaveBeenCalledTimes(1);
    });

    it('treats an answer past its 24 hours as none: clears it and runs the work again', async () => {
      const expired = answer({ expires_at: new Date(now) });
      const t = build({ stored: expired });
      const work = vi.fn<typeof created>(created);
      await t.service.run(call(), work);
      expect(t.remove).toHaveBeenCalledWith(tx, 'person-1', key);
      expect(work).toHaveBeenCalledTimes(1);
      expect(t.insert).toHaveBeenCalledTimes(1);
    });
  });

  it('sweeps the answers past their time and says how many went', async () => {
    const t = build();
    await expect(t.service.sweepExpired()).resolves.toBe(3);
    expect(t.removeExpired).toHaveBeenCalledWith(tx);
  });
});
