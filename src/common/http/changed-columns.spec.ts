import { changedColumns } from './changed-columns.js';

describe('changedColumns', () => {
  const row = { name: 'A', code: 'X' as string | null, version: 1 };

  it('keeps only the columns whose value differs', () => {
    expect(changedColumns(row, { name: 'B', code: 'X' })).toEqual({ name: 'B' });
  });

  it('leaves an omitted column alone and treats null as a value', () => {
    expect(changedColumns(row, { name: undefined, code: null })).toEqual({ code: null });
  });

  it('is empty when nothing changes', () => {
    expect(changedColumns(row, { name: 'A', code: 'X' })).toEqual({});
  });
});
