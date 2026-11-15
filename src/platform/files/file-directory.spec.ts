import type { Tx } from '../database/index.js';
import { FileDirectory } from './file-directory.js';
import { FilePurpose } from './file-purposes.js';
import type { FileRow, FilesRepository } from './files.repository.js';
import type { ObjectStorage } from './object-storage.js';

const tx = {} as Tx;
const want = { purpose: FilePurpose.StaffPhoto, institutionId: 'institution-1' };

const ready = (changes: Partial<FileRow> = {}): FileRow =>
  ({
    id: 'file-1',
    file_status: 2,
    purpose: 4,
    institution_id: 'institution-1',
    ...changes,
  }) as FileRow;

const directory = (found: FileRow | undefined) =>
  new FileDirectory(
    { find: () => Promise.resolve(found) } as unknown as FilesRepository,
    { read: () => Promise.resolve(Buffer.from('a,b')) } as unknown as ObjectStorage,
  );

const refusal = async (promise: Promise<void>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe('FileDirectory.requireReady', () => {
  it('takes a Ready file of the purpose, in the Institution', async () => {
    await expect(
      directory(ready()).requireReady(tx, 'file-1', want, 'photoFileId'),
    ).resolves.toBeUndefined();
  });

  it('answers 404 for a file that is not there or that the caller cannot see', async () => {
    expect(
      await refusal(directory(undefined).requireReady(tx, 'file-1', want, 'photoFileId')),
    ).toMatchObject({
      status: 404,
    });
  });

  it.each([
    ['still Pending', { file_status: 1 }],
    ['Rejected', { file_status: 3 }],
    ['Deleted', { file_status: 4 }],
    ['of another purpose', { purpose: 3 }],
    ['of another Institution', { institution_id: 'institution-2' }],
    ['of no Institution', { institution_id: null }],
  ])('refuses a file that is %s with 400 INVALID_VALUE on the field', async (_name, changes) => {
    const error = await refusal(
      directory(ready(changes)).requireReady(tx, 'file-1', want, 'photoFileId'),
    );
    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      options: {
        errors: [expect.objectContaining({ field: 'photoFileId', code: 'INVALID_VALUE' })],
      },
    });
  });
});

describe('FileDirectory.briefs', () => {
  it('shows what a list needs of each file the caller can see, and leaves the rest out', async () => {
    const rows = [
      ready({
        id: 'a',
        content_type: 'application/pdf',
        size_bytes: 10,
        original_filename: 'a.pdf',
      }),
      ready({ id: 'b', content_type: 'image/png', size_bytes: 20, original_filename: null }),
    ];
    const findMany = vi.fn<FilesRepository['findMany']>().mockResolvedValue(rows);
    const files = new FileDirectory(
      { findMany } as unknown as FilesRepository,
      {} as unknown as ObjectStorage,
    );
    expect(await files.briefs(tx, ['a', 'b', 'gone'])).toEqual(
      new Map([
        ['a', { id: 'a', contentType: 'application/pdf', sizeBytes: 10, fileName: 'a.pdf' }],
        ['b', { id: 'b', contentType: 'image/png', sizeBytes: 20, fileName: null }],
      ]),
    );
    expect(findMany).toHaveBeenCalledWith(tx, ['a', 'b', 'gone']);
  });
});

const uploaded = (changes: Partial<FileRow> = {}) =>
  ready({ purpose: 12, created_by: 'person-1', ...changes });

describe('FileDirectory.requireUploaded', () => {
  const upload = { ...want, purpose: FilePurpose.ImportCsv, uploadedBy: 'person-1' };

  it('takes a Ready file of the purpose that this person uploaded to the Institution', async () => {
    await expect(
      directory(uploaded()).requireUploaded(tx, 'file-1', upload, 'fileId'),
    ).resolves.toBeUndefined();
  });

  it('answers 404 for a file that is not there or that the caller cannot see', async () => {
    expect(
      await refusal(directory(undefined).requireUploaded(tx, 'file-1', upload, 'fileId')),
    ).toMatchObject({ status: 404 });
  });

  it.each([
    ['of another purpose', { purpose: 3 }],
    ['of another Institution', { institution_id: 'institution-2' }],
    ['uploaded by someone else', { created_by: 'person-2' }],
  ])('refuses a file that is %s with 400 INVALID_VALUE on the field', async (_name, changes) => {
    expect(
      await refusal(directory(uploaded(changes)).requireUploaded(tx, 'file-1', upload, 'fileId')),
    ).toMatchObject({
      status: 400,
      options: { errors: [expect.objectContaining({ field: 'fileId', code: 'INVALID_VALUE' })] },
    });
  });

  it.each([
    ['still Pending', 1],
    ['Rejected', 3],
    ['Deleted', 4],
  ])('refuses a file that is %s with 422 FILE_NOT_READY', async (_name, file_status) => {
    expect(
      await refusal(
        directory(uploaded({ file_status })).requireUploaded(tx, 'file-1', upload, 'fileId'),
      ),
    ).toMatchObject({ status: 422, code: 'FILE_NOT_READY' });
  });
});

describe('FileDirectory.contentOf', () => {
  it('reads what a Ready file holds', async () => {
    const content = await directory(ready({ object_key: 'k' })).contentOf(tx, 'file-1');
    expect(content?.toString()).toBe('a,b');
  });

  it('reads nothing of a file that is not Ready or not there', async () => {
    expect(await directory(ready({ file_status: 1 })).contentOf(tx, 'file-1')).toBeNull();
    expect(await directory(undefined).contentOf(tx, 'file-1')).toBeNull();
  });
});
