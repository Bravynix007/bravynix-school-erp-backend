import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import type { Tx } from '../database/index.js';
import type { FilePurpose } from './file-purposes.js';
import { FilesRepository } from './files.repository.js';

const READY = 2;

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
}
