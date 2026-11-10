import type { Tx } from '../../platform/database/index.js';
import type { DocumentRepository } from './document.repository.js';
import { PeopleFileReaders } from './people-file-readers.js';

const tx = {} as Tx;

function build(own = true) {
  const isOwnFile = vi.fn<DocumentRepository['isOwnFile']>().mockResolvedValue(own);
  return {
    readers: new PeopleFileReaders({ isOwnFile } as unknown as DocumentRepository),
    isOwnFile,
  };
}

describe('PeopleFileReaders', () => {
  it('lets a person open the file of their own staff document', async () => {
    const t = build();
    expect(await t.readers.mayOpen(tx, 'user-1', { id: 'file-1', purpose: 6 })).toBe(true);
    expect(t.isOwnFile).toHaveBeenCalledWith(tx, 'file-1', 'user-1');
  });

  it('refuses a file that is not of one of their own active documents', async () => {
    expect(await build(false).readers.mayOpen(tx, 'user-1', { id: 'file-1', purpose: 6 })).toBe(
      false,
    );
  });

  it.each([3, 4, 5, 12])(
    'refuses a file of purpose %s without asking the documents',
    async (purpose) => {
      const t = build();
      expect(await t.readers.mayOpen(tx, 'user-1', { id: 'file-1', purpose })).toBe(false);
      expect(t.isOwnFile).not.toHaveBeenCalled();
    },
  );
});
