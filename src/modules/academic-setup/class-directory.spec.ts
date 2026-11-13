import type { Tx } from '../../platform/database/index.js';
import { ClassDirectory } from './class-directory.js';
import type { ClassRepository } from './class.repository.js';

const tx = {} as Tx;
const build = (found?: { institutionId: string; isLast: boolean }) => {
  const isLast = vi.fn<ClassRepository['isLast']>().mockResolvedValue(found);
  return { directory: new ClassDirectory({ isLast } as unknown as ClassRepository), isLast };
};

describe('ClassDirectory.isLast', () => {
  it('says whether the class is the last of the Institution', async () => {
    const last = build({ institutionId: 'institution-1', isLast: true });
    expect(await last.directory.isLast(tx, 'class-1', 'institution-1')).toBe(true);
    expect(last.isLast).toHaveBeenCalledWith(tx, 'class-1');
    const other = build({ institutionId: 'institution-1', isLast: false });
    expect(await other.directory.isLast(tx, 'class-1', 'institution-1')).toBe(false);
  });

  it('is undefined for a class the caller cannot see, and for one of another Institution', async () => {
    expect(await build().directory.isLast(tx, 'class-1', 'institution-1')).toBeUndefined();
    const abroad = build({ institutionId: 'institution-2', isLast: true });
    expect(await abroad.directory.isLast(tx, 'class-1', 'institution-1')).toBeUndefined();
  });
});

const orders = (entries: [string, { institutionId: string; order: number }][]) => {
  const read = vi.fn<ClassRepository['orders']>().mockResolvedValue(new Map(entries));
  return { directory: new ClassDirectory({ orders: read } as unknown as ClassRepository), read };
};

describe('ClassDirectory.isBelow', () => {
  it('says whether the class comes before the other in the order of the predefined classes', async () => {
    const t = orders([
      ['class-8', { institutionId: 'institution-1', order: 8 }],
      ['class-9', { institutionId: 'institution-1', order: 9 }],
    ]);
    expect(await t.directory.isBelow(tx, 'class-8', 'class-9', 'institution-1')).toBe(true);
    expect(await t.directory.isBelow(tx, 'class-9', 'class-8', 'institution-1')).toBe(false);
    expect(t.read).toHaveBeenCalledWith(tx, ['class-8', 'class-9']);
  });

  it('is not below a class of the same predefined class, such as another stream of the year', async () => {
    const t = orders([
      ['pcmc', { institutionId: 'institution-1', order: 21 }],
      ['pcmb', { institutionId: 'institution-1', order: 21 }],
    ]);
    expect(await t.directory.isBelow(tx, 'pcmc', 'pcmb', 'institution-1')).toBe(false);
  });

  it('is undefined when either class cannot be seen or belongs to another Institution', async () => {
    const one = { institutionId: 'institution-1', order: 8 };
    expect(
      await orders([['a', one]]).directory.isBelow(tx, 'a', 'b', 'institution-1'),
    ).toBeUndefined();
    expect(
      await orders([['b', one]]).directory.isBelow(tx, 'a', 'b', 'institution-1'),
    ).toBeUndefined();
    const abroad = { institutionId: 'institution-2', order: 9 };
    expect(
      await orders([
        ['a', one],
        ['b', abroad],
      ]).directory.isBelow(tx, 'a', 'b', 'institution-1'),
    ).toBeUndefined();
  });
});
