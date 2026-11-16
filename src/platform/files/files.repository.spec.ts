import { isDue, type FileRow } from './files.repository.js';

const NOW = new Date('2026-11-16T04:30:00.000Z');
const due = (delete_after: Date | null) =>
  isDue({ delete_after } as Pick<FileRow, 'delete_after'>, NOW);

describe('isDue', () => {
  it('is true from the moment of delete_after on, and false before it or when there is none', () => {
    expect(due(new Date('2026-11-16T04:29:59.999Z'))).toBe(true);
    expect(due(new Date('2026-11-16T04:30:00.000Z'))).toBe(true);
    expect(due(new Date('2026-11-16T04:30:00.001Z'))).toBe(false);
    expect(due(null)).toBe(false);
  });
});
