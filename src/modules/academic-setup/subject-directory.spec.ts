import type { Tx } from '../../platform/database/index.js';
import { SubjectDirectory } from './subject-directory.js';
import type { SubjectRepository } from './subject.repository.js';

const tx = {} as Tx;

const build = (statuses: [string, number][]) => {
  const statusesOf = vi.fn<SubjectRepository['statusesOf']>().mockResolvedValue(new Map(statuses));
  return {
    directory: new SubjectDirectory({ statusesOf } as unknown as SubjectRepository),
    statusesOf,
  };
};

describe('SubjectDirectory.requireActive', () => {
  it('passes when every subject exists and is active, and for none at all', async () => {
    const t = build([
      ['a', 1],
      ['b', 1],
    ]);
    await expect(t.directory.requireActive(tx, ['a', 'b'], 'subjectIds')).resolves.toBeUndefined();
    await expect(t.directory.requireActive(tx, [], 'subjectIds')).resolves.toBeUndefined();
    expect(t.statusesOf).toHaveBeenCalledWith(tx, ['a', 'b']);
  });

  it('is 404 for a subject the caller cannot see, before it looks at the later ones', async () => {
    const t = build([['b', 0]]);
    await expect(t.directory.requireActive(tx, ['a', 'b'], 'subjectIds')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('is 422 REFERENCE_INACTIVE on the field for a deactivated subject', async () => {
    const t = build([
      ['a', 1],
      ['b', 0],
    ]);
    await expect(t.directory.requireActive(tx, ['a', 'b'], 'subjectIds')).rejects.toMatchObject({
      status: 422,
      code: 'REFERENCE_INACTIVE',
      options: { errors: [{ field: 'subjectIds', code: 'REFERENCE_INACTIVE' }] },
    });
  });
});
