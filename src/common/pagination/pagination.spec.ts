import { AppException } from '../http/app-exception.js';
import {
  containsPattern,
  cursorMeta,
  decodeCursor,
  encodeCursor,
  pageMeta,
  pageOffset,
  parseSort,
  type CursorAt,
} from './pagination.js';

const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url');

describe('page mode', () => {
  it('computes meta and offsets', () => {
    expect(pageMeta(2, 20, 134)).toEqual({ page: 2, limit: 20, totalItems: 134, totalPages: 7 });
    expect(pageMeta(1, 20, 0)).toEqual({ page: 1, limit: 20, totalItems: 0, totalPages: 0 });
    expect(pageOffset(3, 20)).toBe(40);
  });
});

describe('containsPattern', () => {
  it('wraps the text and takes the LIKE wildcards literally', () => {
    expect(containsPattern('sun')).toBe('%sun%');
    expect(containsPattern('100%_a\\b')).toBe('%100\\%\\_a\\\\b%');
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
  const row = {
    id: '0192f6a1-7c40-7e21-8b55-1a2b3c4d5e6f',
    createdAt: '2026-10-23T04:10:00.123456Z' as CursorAt,
  };

  it('round-trips a cursor with microseconds intact', () => {
    const cursor = encodeCursor(row, filters);
    expect(decodeCursor(cursor, { institutionId: 'abc', status: 1 })).toEqual(row);
  });

  it('refuses to encode a millisecond timestamp, which would skip rows', () => {
    expect(() =>
      encodeCursor({ ...row, createdAt: '2026-10-23T04:10:00.123Z' as CursorAt }, filters),
    ).toThrow(/microseconds/);
  });

  it('refuses a cursor reused with other filters', () => {
    const cursor = encodeCursor(row, filters);
    expect(() => decodeCursor(cursor, { ...filters, status: 2 })).toThrow(AppException);
  });

  it('refuses a tampered cursor', () => {
    expect(() => decodeCursor('not-a-cursor', filters)).toThrow(AppException);
    expect(() => decodeCursor(forge({ t: 'yesterday', id: 1, f: 'x' }), filters)).toThrow(
      AppException,
    );
    const good = JSON.parse(
      Buffer.from(encodeCursor(row, filters), 'base64url').toString(),
    ) as object;
    expect(() => decodeCursor(forge({ ...good, id: "x' or 1=1" }), filters)).toThrow(AppException);
  });

  it('returns hasMore and a next cursor when more rows exist', () => {
    const rows = [1, 2, 3].map((n) => ({
      id: `0192f6a1-7c40-7e21-8b55-1a2b3c4d5e6${n}`,
      cursorAt: `2026-10-2${n}T00:00:00.00000${n}Z` as CursorAt,
      name: `row ${n}`,
    }));
    const { items, meta } = cursorMeta(rows, 2, filters);
    expect(items).toEqual([
      { id: rows[0]!.id, name: 'row 1' },
      { id: rows[1]!.id, name: 'row 2' },
    ]);
    expect(meta.hasMore).toBe(true);
    expect(decodeCursor(meta.nextCursor!, filters)).toEqual({
      id: rows[1]!.id,
      createdAt: '2026-10-22T00:00:00.000002Z',
    });
    expect(cursorMeta(rows.slice(0, 2), 2, filters).meta).toEqual({
      limit: 2,
      hasMore: false,
      nextCursor: null,
    });
  });
});
