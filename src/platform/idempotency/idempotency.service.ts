import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiResult, type ListMeta } from '../../common/http/api-result.js';
import { AppException, type FieldError } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { Clock } from '../../common/time/clock.js';
import { DatabaseService, type TenantContext, type Tx } from '../database/index.js';
import {
  IDEMPOTENCY_TTL_MS,
  fingerprintOf,
  isStorableRefusal,
  parseIdempotencyKey,
} from './idempotency.rules.js';
import { IdempotencyRepository, type StoredAnswer } from './idempotency.repository.js';

/** One call to an operation that needs an `Idempotency-Key` (API design 14.1). */
export interface IdempotentCall {
  tenant: TenantContext;
  /** The signed-in person: keys are scoped to them, so nobody's key shows another's result. */
  person: string;
  /** The `Idempotency-Key` header as received. */
  key: string | string[] | undefined;
  /** The name stored with the answer, for example `billing.raise_due`. */
  operation: string;
  /** What makes this request this request: the body and the route parameters. */
  request: unknown;
}

/** What the work produced: the answer to send and the record it made. */
export interface IdempotentOutcome<T> {
  result: ApiResult<T>;
  resourceId?: string;
}

interface StoredSuccess {
  code?: string;
  message?: string;
  data: unknown;
  meta?: ListMeta | null;
}

interface StoredRefusal {
  refusal: true;
  code: string;
  message?: string;
  errors?: FieldError[];
  details?: Record<string, unknown>;
}

/**
 * The `Idempotency-Key` rules (API design 14.2). The first request runs the
 * work and stores its answer in the same transaction, so a crash before commit
 * leaves no key and a retry simply runs again. A repeat with the same key and
 * the same request gets the stored answer back and runs nothing; the same key
 * with another request is 422 `IDEMPOTENCY_KEY_REUSED`; a repeat while the
 * first is still running is 409 `IDEMPOTENCY_IN_PROGRESS`.
 *
 * A stored success is sent again with `Idempotent-Replayed: true`. A stored
 * refusal (409, 422) is sent again as the same refusal, without that header.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly answers: IdempotencyRepository,
    private readonly clock: Clock,
  ) {}

  async run<T>(
    call: IdempotentCall,
    work: (tx: Tx) => Promise<IdempotentOutcome<T>>,
  ): Promise<ApiResult<T>> {
    const key = parseIdempotencyKey(call.key);
    const fingerprint = fingerprintOf(call.operation, call.request);
    let replayedRefusal = false;
    try {
      return await this.database.transaction(this.tenantOf(call), async (tx) => {
        if (!(await this.answers.claim(tx, call.person, key))) throw inProgress();
        const stored = await this.stored(tx, call.person, key);
        if (stored) {
          if (
            stored.operation !== call.operation ||
            !stored.request_fingerprint.equals(fingerprint)
          ) {
            throw new AppException(
              HttpStatus.UNPROCESSABLE_ENTITY,
              ErrorCode.IDEMPOTENCY_KEY_REUSED,
            );
          }
          try {
            return replay<T>(stored);
          } catch (error) {
            replayedRefusal = true;
            throw error;
          }
        }
        const { result, resourceId } = await work(tx);
        await this.answers.insert(
          tx,
          this.row(call, key, fingerprint, resourceId, {
            status: result.options.status ?? HttpStatus.OK,
            body: {
              code: result.options.code,
              message: result.options.message,
              data: result.data,
              meta: result.options.meta ?? null,
            } satisfies StoredSuccess,
          }),
        );
        return result;
      });
    } catch (error) {
      if (!replayedRefusal && isStorableRefusal(error)) {
        await this.rememberRefusal(call, key, fingerprint, error);
      }
      throw error;
    }
  }

  /**
   * The hourly sweep (DDD 14.2), run by the job runner when it exists; says how many answers it removed.
   * It runs as the platform: row-level security lets Super Admin delete other people's answers.
   */
  sweepExpired(): Promise<number> {
    return this.database.transaction({ roleCode: 1 }, (tx) =>
      this.answers.removeExpired(tx, this.clock.now()),
    );
  }

  /** The caller's tenant with the signed-in person set: the policy on stored answers reads it. */
  private tenantOf(call: IdempotentCall): TenantContext {
    return { ...call.tenant, personId: call.person };
  }

  /** An answer past its 24 hours counts as none, and is cleared so the key can be used again. */
  private async stored(tx: Tx, person: string, key: string): Promise<StoredAnswer | undefined> {
    const found = await this.answers.find(tx, person, key);
    if (found && found.expires_at <= this.clock.now()) {
      await this.answers.remove(tx, person, key);
      return undefined;
    }
    return found;
  }

  /**
   * A refusal rolled its transaction back, so it is written in a transaction of
   * its own. Best effort: if the first request is somehow still running, or the
   * write fails, the refusal is simply not stored and a retry computes it again.
   */
  private async rememberRefusal(
    call: IdempotentCall,
    key: string,
    fingerprint: Buffer,
    error: AppException,
  ): Promise<void> {
    try {
      await this.database.transaction(this.tenantOf(call), async (tx) => {
        if (!(await this.answers.claim(tx, call.person, key))) return;
        await this.answers.insert(
          tx,
          this.row(call, key, fingerprint, undefined, {
            status: error.status,
            body: {
              refusal: true,
              code: error.code,
              message: error.options.message,
              errors: error.options.errors,
              details: error.options.details,
            } satisfies StoredRefusal,
          }),
        );
      });
    } catch {
      // The refusal still reaches the caller; only its replay is lost.
    }
  }

  private row(
    call: IdempotentCall,
    key: string,
    fingerprint: Buffer,
    resourceId: string | undefined,
    answer: { status: number; body: StoredSuccess | StoredRefusal },
  ) {
    const now = this.clock.now();
    return {
      user_id: call.person,
      idempotency_key: key,
      operation: call.operation,
      request_fingerprint: fingerprint,
      response_status: answer.status,
      response_body: JSON.stringify(answer.body),
      resource_id: resourceId ?? null,
      created_at: now,
      expires_at: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
    };
  }
}

function inProgress(): AppException {
  return new AppException(HttpStatus.CONFLICT, ErrorCode.IDEMPOTENCY_IN_PROGRESS, {
    retryAfterSeconds: 1,
  });
}

/** The stored answer, sent again: a success as itself, a refusal thrown as the same refusal. */
function replay<T>(stored: StoredAnswer): ApiResult<T> {
  const body = stored.response_body as StoredSuccess | StoredRefusal;
  if ('refusal' in body) {
    throw new AppException(stored.response_status, body.code, {
      message: body.message,
      errors: body.errors,
      details: body.details,
    });
  }
  return new ApiResult(body.data as T, {
    status: stored.response_status,
    code: body.code,
    message: body.message,
    meta: body.meta ?? null,
    headers: { 'Idempotent-Replayed': 'true' },
  });
}
