import { v7 as uuidv7, validate } from 'uuid';

/** A new time-ordered UUIDv7 (DDD 10.1). The server makes every ID. */
export function newId(): string {
  return uuidv7();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && validate(value);
}
