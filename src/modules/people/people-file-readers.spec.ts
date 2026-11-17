import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { Tx } from '../../platform/database/index.js';
import type { ChildAccess } from './child-access.js';
import type { DocumentRepository } from './document.repository.js';
import { PeopleFileReaders } from './people-file-readers.js';

const tx = {} as Tx;

function build(own = true) {
  const isOwnFile = vi.fn<DocumentRepository['isOwnFile']>().mockResolvedValue(own);
  const studentOfFile = vi.fn<DocumentRepository['studentOfFile']>().mockResolvedValue('stu-1');
  const ofRecord = vi.fn<ChildAccess['ofRecord']>().mockImplementation(async (_principal, find) => {
    await find(tx);
    return { institutionId: 'ins-1', societyId: 'soc-1', tenant: { childIds: ['stu-1'] } };
  });
  return {
    readers: new PeopleFileReaders(
      { isOwnFile, studentOfFile } as unknown as DocumentRepository,
      { ofRecord } as unknown as ChildAccess,
    ),
    isOwnFile,
    studentOfFile,
    ofRecord,
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

  it('gives a parent the tenant of the child the file belongs to, found through the documents', async () => {
    const t = build();
    const principal = { personId: 'user-1', roleCode: 5 } as Principal;
    await expect(t.readers.parentTenant(principal, 'file-1')).resolves.toEqual({
      childIds: ['stu-1'],
    });
    expect(t.ofRecord).toHaveBeenCalledWith(principal, expect.any(Function));
    expect(t.studentOfFile).toHaveBeenCalledWith(tx, 'file-1');
  });
});
