import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { Clock } from '../../common/time/clock.js';
import { fieldError } from '../../common/validation/field-error.js';
import type { Tx } from '../database/index.js';
import type { FilePurpose } from './file-purposes.js';
import { FilesRepository, isDue } from './files.repository.js';
import { ObjectStorage } from './object-storage.js';

const READY = 2;

/** What a list shows of a private file: never its key or bucket (API design 7.3). */
export interface FileBrief {
  id: string;
  contentType: string;
  sizeBytes: number;
  /** The name the uploader gave, for the purposes that keep it. */
  fileName: string | null;
}

/**
 * What other modules need of a file when a record points at one (API design 15.1): the file exists and the caller
 * may see it (404, row-level security hides another Society's), and it is a Ready file of the purpose the field
 * takes, in the Institution of the record (400 `INVALID_VALUE` on the field). A record that already points at a
 * file keeps it; only a new link is checked. A file past its `delete_after` is as good as gone: the worker removes its
 * object at its next sweep, so it is not Ready for a new link or an operation (DDD 16.4).
 */
@Injectable()
export class FileDirectory {
  constructor(
    private readonly files: FilesRepository,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
  ) {}

  async requireReady(
    tx: Tx,
    fileId: string,
    expect: { purpose: FilePurpose; institutionId: string },
    field: string,
  ): Promise<void> {
    const file = await this.files.find(tx, fileId);
    if (!file) throw AppException.notFound();
    if (
      file.file_status !== READY ||
      isDue(file, this.clock.now()) ||
      file.purpose !== expect.purpose ||
      file.institution_id !== expect.institutionId
    ) {
      throw AppException.validation([fieldError(field, FieldErrorCode.INVALID_VALUE)]);
    }
  }

  /**
   * A file a person uploaded to start an operation on it (an import): the caller can see it (404 otherwise), and it is a
   * file of the purpose, in the Institution, that this person uploaded (400 `INVALID_VALUE` on the field). It is also
   * Ready, else 422 `FILE_NOT_READY`: the upload was not confirmed, or the file was refused or removed.
   */
  async requireUploaded(
    tx: Tx,
    fileId: string,
    expect: { purpose: FilePurpose; institutionId: string; uploadedBy: string },
    field: string,
  ): Promise<void> {
    const file = await this.files.find(tx, fileId);
    if (!file) throw AppException.notFound();
    if (
      file.purpose !== expect.purpose ||
      file.institution_id !== expect.institutionId ||
      file.created_by !== expect.uploadedBy
    ) {
      throw AppException.validation([fieldError(field, FieldErrorCode.INVALID_VALUE)]);
    }
    if (file.file_status !== READY || isDue(file, this.clock.now())) {
      throw AppException.businessRule(ErrorCode.FILE_NOT_READY);
    }
  }

  /** What a Ready file holds (at most 5 MB), for the module that owns it to read; `null` when nothing is stored. */
  async contentOf(tx: Tx, fileId: string): Promise<Buffer | null> {
    const file = await this.files.find(tx, fileId);
    return file?.file_status === READY ? this.storage.read(file.object_key) : null;
  }

  /** The files the caller can see among `ids`, by ID. */
  async briefs(tx: Tx, ids: readonly string[]): Promise<Map<string, FileBrief>> {
    const rows = await this.files.findMany(tx, ids);
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          contentType: row.content_type,
          sizeBytes: row.size_bytes,
          fileName: row.original_filename,
        },
      ]),
    );
  }
}
