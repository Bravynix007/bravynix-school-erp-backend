import { authorOf, authorStamps, SYSTEM_AUTHOR, type AuthorRef } from './author-stamps.js';

const nair: AuthorRef = { id: 'p1', displayName: 'R. Nair', roleName: 'Teacher' };
const people = new Map([['p1', nair]]);

describe('author stamps (API design 7.6)', () => {
  it('shows a known person, System for none, and keeps the ID of one nobody knows', () => {
    expect(authorOf('p1', people)).toBe(nair);
    expect(authorOf(null, people)).toEqual({ id: null, displayName: 'System', roleName: null });
    expect(authorOf('gone', people)).toEqual({
      id: 'gone',
      displayName: 'Unknown',
      roleName: null,
    });
  });

  it('builds the four fields, instants in UTC with milliseconds', () => {
    const stamps = authorStamps(
      {
        created_by: 'p1',
        created_at: new Date('2026-10-23T04:10:00.000Z'),
        updated_by: null,
        updated_at: new Date('2026-10-24T05:00:00.000Z'),
      },
      people,
    );
    expect(stamps).toEqual({
      createdBy: nair,
      createdAt: '2026-10-23T04:10:00.000Z',
      updatedBy: SYSTEM_AUTHOR,
      updatedAt: '2026-10-24T05:00:00.000Z',
    });
  });
});
