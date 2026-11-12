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
