import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { AppException } from '../http/app-exception.js';
import type { CursorMeta, PageMeta } from '../http/api-result.js';
import { ErrorCode, FieldErrorCode } from '../http/error-codes.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Query parameters for page-mode lists (API design 13.1). */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
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

interface CursorPayload {
  /** createdAt of the last row, ISO string. */
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

export function encodeCursor(
  last: { createdAt: Date | string; id: string },
  filters: Record<string, unknown>,
): string {
  const payload: CursorPayload = {
    t: new Date(last.createdAt).toISOString(),
    id: last.id,
    f: filterHash(filters),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function invalidCursor(): AppException {
  return new AppException(HttpStatus.BAD_REQUEST, ErrorCode.CURSOR_INVALID, {
    errors: [{ field: 'cursor', code: FieldErrorCode.INVALID_VALUE, message: 'Invalid cursor' }],
  });
}

/** Decodes a cursor; a tampered cursor or one reused with other filters is 400 CURSOR_INVALID. */
export function decodeCursor(
  cursor: string,
  filters: Record<string, unknown>,
): { createdAt: Date; id: string } {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw invalidCursor();
  }
  const createdAt = new Date(payload?.t);
  if (
    typeof payload?.id !== 'string' ||
    Number.isNaN(createdAt.getTime()) ||
    payload.f !== filterHash(filters)
  ) {
    throw invalidCursor();
  }
  return { createdAt, id: payload.id };
}

export function cursorMeta<T extends { createdAt: Date | string; id: string }>(
  rows: T[],
  limit: number,
  filters: Record<string, unknown>,
): { items: T[]; meta: CursorMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    meta: { limit, hasMore, nextCursor: hasMore && last ? encodeCursor(last, filters) : null },
  };
}
