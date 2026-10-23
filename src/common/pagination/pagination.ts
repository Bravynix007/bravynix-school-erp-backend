import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { AppException } from '../http/app-exception.js';
import type { CursorMeta, PageMeta } from '../http/api-result.js';
import { ErrorCode, FieldErrorCode } from '../http/error-codes.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/** Keeps OFFSET small enough for PostgreSQL to answer quickly (API design 13.1). */
export const MAX_PAGE = 10_000;

/** Query parameters for page-mode lists (API design 13.1). */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit: number = DEFAULT_LIMIT;

  @IsOptional()
  @IsString()
  sort?: string;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  q?: string;
}

/** Query parameters for cursor-mode lists (API design 13.2). */
export class CursorQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit: number = DEFAULT_LIMIT;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export function pageMeta(page: number, limit: number, totalItems: number): PageMeta {
  return { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) };
}

export function pageOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}

export interface SortKey<F extends string> {
  field: F;
  direction: 'asc' | 'desc';
}

/**
 * Parses `sort=rollNumber,-createdAt` against the endpoint's allowed fields.
 * Unknown fields are 400 INVALID_SORT. Callers always add `id` as the final
 * key so pages never repeat or skip a row.
 */
export function parseSort<F extends string>(
  sort: string | undefined,
  allowed: readonly F[],
  fallback: SortKey<F>[],
): SortKey<F>[] {
  if (!sort) return fallback;
  const keys = sort
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean);
  return keys.map((raw) => {
    const direction = raw.startsWith('-') ? 'desc' : 'asc';
    const field = raw.replace(/^[-+]/, '') as F;
    if (!allowed.includes(field)) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_SORT, {
        errors: [
          { field: 'sort', code: ErrorCode.INVALID_SORT, message: `Unknown sort field: ${field}` },
        ],
      });
    }
    return { field, direction };
  });
}

/**
 * A row's position in a newest-first `(created_at, id)` list (API design
 * 13.2). `createdAt` keeps PostgreSQL's microseconds, which a JS `Date`
 * would round to milliseconds and make the next page skip rows.
 */
export interface CursorPosition {
  /** UTC, microsecond precision: `2026-10-23T04:25:00.123456Z`. */
  createdAt: string;
  id: string;
}

const MICROS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Selects a timestamp column as a microsecond UTC string for the cursor:
 * `.select(cursorTimestamp('n.created_at').as('cursorAt'))`.
 */
export function cursorTimestamp(column = 'created_at'): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** `(created_at, id) < cursor`, the keyset condition for the next newest-first page. */
export function beforeCursor(
  position: CursorPosition,
  column = 'created_at',
  idColumn = 'id',
): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(column)}, ${sql.ref(idColumn)}) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`;
}

interface CursorPayload {
  /** createdAt of the last row, microsecond UTC string. */
  t: string;
  /** id of the last row. */
  id: string;
  /** Hash of the filters the cursor was made with. */
  f: string;
}

function filterHash(filters: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(filters)
      .toSorted()
      .map((key) => [key, filters[key] ?? null]),
  );
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16);
}

export function encodeCursor(last: CursorPosition, filters: Record<string, unknown>): string {
  if (!MICROS_ISO.test(last.createdAt)) {
    throw new Error('Cursor timestamps must come from cursorTimestamp(), with microseconds');
  }
  const payload: CursorPayload = { t: last.createdAt, id: last.id, f: filterHash(filters) };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function invalidCursor(): AppException {
  return new AppException(HttpStatus.BAD_REQUEST, ErrorCode.CURSOR_INVALID, {
    errors: [{ field: 'cursor', code: FieldErrorCode.INVALID_VALUE, message: 'Invalid cursor' }],
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decodes a cursor; a tampered cursor or one reused with other filters is 400 CURSOR_INVALID. */
export function decodeCursor(cursor: string, filters: Record<string, unknown>): CursorPosition {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw invalidCursor();
  }
  if (
    typeof payload?.t !== 'string' ||
    !MICROS_ISO.test(payload.t) ||
    typeof payload.id !== 'string' ||
    !UUID.test(payload.id) ||
    payload.f !== filterHash(filters)
  ) {
    throw invalidCursor();
  }
  return { createdAt: payload.t, id: payload.id };
}

/**
 * Splits `limit + 1` fetched rows into the page and its meta. Rows carry
 * `cursorAt` from `cursorTimestamp()` alongside their `id`.
 */
export function cursorMeta<T extends { cursorAt: string; id: string }>(
  rows: T[],
  limit: number,
  filters: Record<string, unknown>,
): { items: T[]; meta: CursorMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    meta: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last ? encodeCursor({ createdAt: last.cursorAt, id: last.id }, filters) : null,
    },
  };
}
