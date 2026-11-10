import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import type { Tx } from '../database/index.js';
import type { FilePurpose } from './file-purposes.js';
import { FilesRepository } from './files.repository.js';

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
 * file keeps it; only a new link is checked.
 */
@Injectable()
export class FileDirectory {
  constructor(private readonly files: FilesRepository) {}

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
      file.purpose !== expect.purpose ||
      file.institution_id !== expect.institutionId
    ) {
      throw AppException.validation([fieldError(field, FieldErrorCode.INVALID_VALUE)]);
    }
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
