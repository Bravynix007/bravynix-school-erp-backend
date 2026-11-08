import { createHash } from 'node:crypto';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService, Tx } from '../database/index.js';
import type { ScopeService } from '../tenancy/index.js';
import type { FilesRepository, FileRow } from './files.repository.js';
import { FilesService } from './files.service.js';
import { ObjectStorage } from './object-storage.js';

const admin = (overrides: Partial<Principal> = {}): Principal =>
  ({
    personId: 'admin-1',
    sessionId: 'session-1',
    roleCode: 3,
    societyId: 'society-1',
    clientType: 'mobile',
    viaSupportAccess: false,
    ...overrides,
  }) as Principal;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const file = (overrides: Partial<FileRow> = {}): FileRow => ({
  id: 'file-1',
  created_at: new Date('2026-11-08T10:00:00.000Z'),
  created_by: 'admin-1',
  society_id: 'society-1',
  institution_id: 'institution-1',
  storage_bucket: 1,
  object_key: 'society-1/institution-1/3/abc',
  purpose: 3,
  content_type: 'image/jpeg',
  size_bytes: JPEG.length,
  original_filename: null,
  checksum_sha256: null,
  file_status: 1,
  confirmed_at: null,
  delete_after: new Date('2026-11-09T10:00:00.000Z'),
  deleted_at: null,
  ...overrides,
});

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

function build(stored: FileRow | null = file(), bytes: Buffer | null = JPEG) {
  const clock = new FixedClock('2026-11-08T10:00:00.000Z');
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<FilesRepository['find']>().mockResolvedValue(stored ?? undefined);
  const insert = vi
    .fn<FilesRepository['insert']>()
    .mockImplementation((_tx, values) => Promise.resolve(file(values as Partial<FileRow>)));
  const settlePending = vi
    .fn<FilesRepository['settlePending']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(file({ ...stored, ...(changes as Partial<FileRow>), id })),
    );
  const read = vi.fn<ObjectStorage['read']>().mockResolvedValue(bytes);
  const remove = vi.fn<ObjectStorage['remove']>().mockResolvedValue();
  const createUpload = vi
    .fn<ObjectStorage['createUpload']>()
    .mockImplementation((input) =>
      Promise.resolve({ url: 'http://store/up', fields: {}, expiresAt: input.expiresAt }),
    );
  const createDownload = vi
    .fn<ObjectStorage['createDownload']>()
    .mockImplementation((input) =>
      Promise.resolve({ url: 'http://store/down', expiresAt: input.expiresAt }),
    );
  const tenant = {
    personId: 'admin-1',
    roleCode: 3,
    societyId: 'society-1',
    institutionIds: ['institution-1'],
  };
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue({
    institutionId: 'institution-1',
    societyId: 'society-1',
    tenant,
  });
  const forPrincipal = vi.fn<ScopeService['forPrincipal']>().mockResolvedValue({ tenant } as never);
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new FilesService(
    { transaction } as unknown as DatabaseService,
    { find, insert, settlePending } as unknown as FilesRepository,
    { read, remove, createUpload, createDownload } as unknown as ObjectStorage,
    { requireInstitution, forPrincipal } as unknown as ScopeService,
    { record } as unknown as AuditService,
    clock,
  );
  return {
    service,
    find,
    insert,
    settlePending,
    read,
    remove,
    createUpload,
    createDownload,
    requireInstitution,
    record,
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  purpose: 3,
  institutionId: 'institution-1',
  contentType: 'image/jpeg',
  sizeBytes: 1000,
  fileName: 'photo.jpg',
  ...overrides,
});

describe('FilesService', () => {
  describe('requestUpload (FIL-01)', () => {
    it('records a Pending file under the Institution and answers with a five-minute ticket', async () => {
      const t = build();
      const grant = await t.service.requestUpload(admin(), request() as never);
      expect(grant).toMatchObject({ fileId: expect.any(String), maxBytes: 5_242_880 });
      expect(grant.upload.expiresAt).toEqual(new Date('2026-11-08T10:05:00.000Z'));
      const [, row] = t.insert.mock.calls[0]!;
      expect(row).toMatchObject({
        created_by: 'admin-1',
        society_id: 'society-1',
        institution_id: 'institution-1',
        storage_bucket: 1,
        purpose: 3,
        content_type: 'image/jpeg',
        size_bytes: 1000,
        delete_after: new Date('2026-11-09T10:00:00.000Z'),
      });
      expect(row.object_key).toMatch(/^society-1\/institution-1\/3\/[\w-]+$/);
      expect(t.createUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          key: row.object_key,
          contentType: 'image/jpeg',
          maxBytes: 5_242_880,
        }),
      );
    });

    it('keeps the name of a document but not of a photo, and strips any path from it', async () => {
      const t = build();
      await t.service.requestUpload(admin(), request({ purpose: 3, fileName: 'me.jpg' }) as never);
      await t.service.requestUpload(
        admin(),
        request({
          purpose: 5,
          contentType: 'application/pdf',
          fileName: '..\\..\\etc/form\u0000.pdf',
        }) as never,
      );
      expect(t.insert.mock.calls[0]![1].original_filename).toBeNull();
      expect(t.insert.mock.calls[1]![1].original_filename).toBe('form.pdf');
    });

    it('takes exactly 5 MB, and keeps no name for a path with none', async () => {
      const t = build();
      await t.service.requestUpload(admin(), request({ sizeBytes: 5_242_880 }) as never);
      await t.service.requestUpload(
        admin(),
        request({ purpose: 5, contentType: 'application/pdf', fileName: 'docs/' }) as never,
      );
      await t.service.requestUpload(
        admin(),
        request({ purpose: 5, contentType: 'application/pdf', fileName: 'a\u200Bb.pdf' }) as never,
      );
      expect(t.insert.mock.calls[0]![1].size_bytes).toBe(5_242_880);
      expect(t.insert.mock.calls[1]![1].original_filename).toBeNull();
      expect(t.insert.mock.calls[2]![1].original_filename).toBe('ab.pdf');
    });

    it('refuses more than 5 MB with 413 and a type the purpose does not take with 415', async () => {
      const t = build();
      expect(
        await fail(t.service.requestUpload(admin(), request({ sizeBytes: 5_242_881 }) as never)),
      ).toEqual({
        status: 413,
        code: 'FILE_TOO_LARGE',
      });
      expect(
        await fail(
          t.service.requestUpload(admin(), request({ contentType: 'application/pdf' }) as never),
        ),
      ).toEqual({ status: 415, code: 'FILE_TYPE_NOT_ALLOWED' });
      expect(
        await fail(
          t.service.requestUpload(
            admin(),
            request({ purpose: 12, contentType: 'image/png' }) as never,
          ),
        ),
      ).toEqual({ status: 415, code: 'FILE_TYPE_NOT_ALLOWED' });
      expect(t.insert).not.toHaveBeenCalled();
    });

    it('refuses a role the purpose does not allow, before reaching the Institution', async () => {
      const t = build();
      expect(
        await fail(t.service.requestUpload(admin({ roleCode: 4 }), request() as never)),
      ).toMatchObject({
        status: 403,
      });
      expect(t.requireInstitution).not.toHaveBeenCalled();
    });
  });

  describe('confirm (FIL-02)', () => {
    it('reads what arrived, and calls the file Ready with its checksum', async () => {
      const t = build();
      const ready = await t.service.confirm(admin(), 'file-1');
      expect(ready).toEqual({
        id: 'file-1',
        purpose: 3,
        contentType: 'image/jpeg',
        sizeBytes: JPEG.length,
        fileStatus: 2,
      });
      const [, id, changes] = t.settlePending.mock.calls[0]!;
      expect(id).toBe('file-1');
      expect(changes).toMatchObject({
        file_status: 2,
        confirmed_at: new Date('2026-11-08T10:00:00.000Z'),
        checksum_sha256: createHash('sha256').update(JPEG).digest(),
        delete_after: null,
      });
    });

    it('keeps an import for seven days', async () => {
      const csv = Buffer.from('Name,RollNumber\n');
      const t = build(file({ purpose: 12, content_type: 'text/csv', size_bytes: csv.length }), csv);
      await t.service.confirm(admin(), 'file-1');
      expect(t.settlePending.mock.calls[0]![2]).toMatchObject({
        delete_after: new Date('2026-11-15T10:00:00.000Z'),
      });
    });

    it('is 404 for a file that is not the caller’s, is missing, or was rejected or deleted', async () => {
      expect(await fail(build(null).service.confirm(admin(), 'file-1'))).toMatchObject({
        status: 404,
      });
      expect(
        await fail(build().service.confirm(admin({ personId: 'other' }), 'file-1')),
      ).toMatchObject({
        status: 404,
      });
      expect(
        await fail(build(file({ file_status: 3 })).service.confirm(admin(), 'file-1')),
      ).toMatchObject({
        status: 404,
      });
      expect(
        await fail(build(file({ file_status: 4 })).service.confirm(admin(), 'file-1')),
      ).toMatchObject({
        status: 404,
      });
    });

    it('is 409 for a second confirm, and for a race lost to another confirm', async () => {
      const done = build(file({ file_status: 2 }));
      expect(await fail(done.service.confirm(admin(), 'file-1'))).toEqual({
        status: 409,
        code: 'ALREADY_CONFIRMED',
      });
      expect(done.read).not.toHaveBeenCalled();
      const raced = build();
      raced.settlePending.mockResolvedValue(undefined);
      expect(await fail(raced.service.confirm(admin(), 'file-1'))).toMatchObject({ status: 409 });
    });

    it('is 422 UPLOAD_NOT_FOUND when nothing arrived, and the file stays Pending', async () => {
      const t = build(file(), null);
      expect(await fail(t.service.confirm(admin(), 'file-1'))).toEqual({
        status: 422,
        code: 'UPLOAD_NOT_FOUND',
      });
      expect(t.settlePending).not.toHaveBeenCalled();
      expect(t.remove).not.toHaveBeenCalled();
    });

    it.each([
      ['the wrong size', JPEG.subarray(0, 4)],
      ['the wrong type', Buffer.from('%PDF-1.7 and some more bytes')],
      ['the right size but another type', Buffer.from('%PDF-1.7 '.padEnd(JPEG.length, 'x'))],
    ])(
      'discards a file with %s: object removed, file Rejected, 422 FILE_CHECK_FAILED',
      async (_name, bytes) => {
        const t = build(
          file({ size_bytes: _name.includes('right size') ? bytes.length : JPEG.length }),
          bytes,
        );
        expect(await fail(t.service.confirm(admin(), 'file-1'))).toEqual({
          status: 422,
          code: 'FILE_CHECK_FAILED',
        });
        expect(t.remove).toHaveBeenCalledWith('society-1/institution-1/3/abc');
        expect(t.settlePending.mock.calls[0]![2]).toMatchObject({
          file_status: 3,
          deleted_at: new Date('2026-11-08T10:00:00.000Z'),
        });
      },
    );
  });

  describe('download (FIL-03)', () => {
    it('gives the uploader a five-minute link, with the name for a document', async () => {
      const t = build(file({ file_status: 2, original_filename: 'form.pdf' }));
      const link = await t.service.download(admin(), 'file-1');
      expect(link.expiresAt).toEqual(new Date('2026-11-08T10:05:00.000Z'));
      expect(t.createDownload).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'image/jpeg', fileName: 'form.pdf' }),
      );
    });

    it('gives an Owner or Admin another person’s file; row-level security has narrowed them to their Institutions', async () => {
      const row = file({ file_status: 2, created_by: 'someone-else' });
      expect(
        (await build(row).service.download(admin({ personId: 'o', roleCode: 2 }), 'file-1')).url,
      ).toBe('http://store/down');
    });

    it('is 404 for a purpose nobody registered', async () => {
      expect(
        await fail(build(file({ file_status: 2, purpose: 8 })).service.download(admin(), 'file-1')),
      ).toMatchObject({ status: 404 });
    });

    it('is 404 for a file that is missing or not Ready', async () => {
      expect(await fail(build(null).service.download(admin(), 'file-1'))).toMatchObject({
        status: 404,
      });
      expect(await fail(build(file()).service.download(admin(), 'file-1'))).toMatchObject({
        status: 404,
      });
    });

    it('audits the link of a document, and of an import, but not of a photo', async () => {
      const document = build(file({ file_status: 2, purpose: 5, content_type: 'application/pdf' }));
      await document.service.download(admin(), 'file-1');
      expect(document.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'file.download',
          institutionId: 'institution-1',
          societyId: 'society-1',
          entityType: 'file',
          entityId: 'file-1',
        }),
      );
      const photo = build(file({ file_status: 2 }));
      await photo.service.download(admin(), 'file-1');
      expect(photo.record).not.toHaveBeenCalled();
    });
  });
});
