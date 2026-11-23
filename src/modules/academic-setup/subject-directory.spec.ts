import type { Tx } from '../../platform/database/index.js';
import { SubjectDirectory } from './subject-directory.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { SubjectRepository, SubjectRow } from './subject.repository.js';

const tx = {} as Tx;

const build = (statuses: [string, number][]) => {
  const statusesOf = vi.fn<SubjectRepository['statusesOf']>().mockResolvedValue(new Map(statuses));
  return {
    directory: new SubjectDirectory(
      { statusesOf } as unknown as SubjectRepository,
      {} as PersonDirectory,
    ),
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

describe('SubjectDirectory.names', () => {
  it('gives the names through the repository', async () => {
    const namesOf = vi
      .fn<SubjectRepository['namesOf']>()
      .mockResolvedValue(new Map([['a', 'Maths']]));
    const directory = new SubjectDirectory(
      { namesOf } as unknown as SubjectRepository,
      {} as PersonDirectory,
    );
    expect((await directory.names(tx, ['a'])).get('a')).toBe('Maths');
    expect(namesOf).toHaveBeenCalledWith(tx, ['a']);
  });
});

describe('SubjectDirectory.active and resources', () => {
  const row = {
    id: 'a',
    name: 'Maths',
    code: 'MATH',
    status: 1,
    version: 3,
    created_at: new Date('2026-11-01T00:00:00.000Z'),
    created_by: 'person-1',
    updated_at: new Date('2026-11-01T00:00:00.000Z'),
    updated_by: 'person-1',
  } as SubjectRow;

  it('reads the Society’s active subjects through the repository, all or only the ones named', async () => {
    const active = vi.fn<SubjectRepository['active']>().mockResolvedValue([row]);
    const directory = new SubjectDirectory(
      { active } as unknown as SubjectRepository,
      {} as PersonDirectory,
    );
    expect(await directory.active(tx, 'society-1')).toEqual([row]);
    expect(active).toHaveBeenLastCalledWith(tx, 'society-1', undefined);
    await directory.active(tx, 'society-1', ['a']);
    expect(active).toHaveBeenLastCalledWith(tx, 'society-1', ['a']);
  });

  it('shows the subjects as SUB-01 does, with who made them', async () => {
    const describe = vi
      .fn<PersonDirectory['describe']>()
      .mockResolvedValue(
        new Map([['person-1', { id: 'person-1', displayName: 'Asha Rao', roleName: null }]]),
      );
    const directory = new SubjectDirectory(
      {} as SubjectRepository,
      { describe } as unknown as PersonDirectory,
    );
    const [shown] = await directory.resources([row]);
    expect(shown).toMatchObject({
      id: 'a',
      name: 'Maths',
      code: 'MATH',
      status: 1,
      version: 3,
      createdBy: { id: 'person-1', displayName: 'Asha Rao', roleName: null },
    });
    expect(describe).toHaveBeenCalledWith(['person-1']);
  });
});
