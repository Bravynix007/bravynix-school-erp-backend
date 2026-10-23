import { AppException } from '../http/app-exception.js';
import {
  cursorMeta,
  decodeCursor,
  encodeCursor,
  pageMeta,
  pageOffset,
  parseSort,
} from './pagination.js';

describe('page mode', () => {
  it('computes meta and offsets', () => {
    expect(pageMeta(2, 20, 134)).toEqual({ page: 2, limit: 20, totalItems: 134, totalPages: 7 });
    expect(pageMeta(1, 20, 0)).toEqual({ page: 1, limit: 20, totalItems: 0, totalPages: 0 });
    expect(pageOffset(3, 20)).toBe(40);
  });
});

describe('parseSort', () => {
  const allowed = ['rollNumber', 'createdAt'] as const;

  it('parses ascending and descending keys', () => {
    expect(parseSort('rollNumber,-createdAt', allowed, [])).toEqual([
      { field: 'rollNumber', direction: 'asc' },
      { field: 'createdAt', direction: 'desc' },
    ]);
  });

  it('falls back when no sort is given', () => {
    const fallback = [{ field: 'createdAt' as const, direction: 'desc' as const }];
    expect(parseSort(undefined, allowed, fallback)).toBe(fallback);
  });

  it('rejects unknown fields with INVALID_SORT', () => {
    expect(() => parseSort('password', allowed, [])).toThrow(
      expect.objectContaining({ code: 'INVALID_SORT', status: 400 }),
    );
  });
});

describe('cursor mode', () => {
  const filters = { status: 1, institutionId: 'abc' };
  const row = { id: '0192f6a1-7c40-7e21-8b55-1a2b3c4d5e6f', createdAt: '2026-10-23T04:10:00.000Z' };

  it('round-trips a cursor', () => {
    const cursor = encodeCursor(row, filters);
    const decoded = decodeCursor(cursor, { institutionId: 'abc', status: 1 });
    expect(decoded.id).toBe(row.id);
    expect(decoded.createdAt.toISOString()).toBe(row.createdAt);
  });

  it('refuses a cursor reused with other filters', () => {
    const cursor = encodeCursor(row, filters);
    expect(() => decodeCursor(cursor, { ...filters, status: 2 })).toThrow(AppException);
  });

  it('refuses a tampered cursor', () => {
    expect(() => decodeCursor('not-a-cursor', filters)).toThrow(AppException);
    const forged = Buffer.from(JSON.stringify({ t: 'yesterday', id: 1, f: 'x' })).toString(
      'base64url',
    );
    expect(() => decodeCursor(forged, filters)).toThrow(AppException);
  });

  it('returns hasMore and a next cursor when more rows exist', () => {
    const rows = [1, 2, 3].map((n) => ({
      id: `id-${n}`,
      createdAt: `2026-10-2${n}T00:00:00.000Z`,
    }));
    const { items, meta } = cursorMeta(rows, 2, filters);
    expect(items).toHaveLength(2);
    expect(meta.hasMore).toBe(true);
    expect(decodeCursor(meta.nextCursor!, filters).id).toBe('id-2');
    expect(cursorMeta(rows.slice(0, 2), 2, filters).meta).toEqual({
      limit: 2,
      hasMore: false,
      nextCursor: null,
    });
  });
});
