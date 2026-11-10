import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { FilePurpose, FileReaders, type FileToOpen } from '../../platform/files/index.js';
import { DocumentRepository } from './document.repository.js';

/**
 * What People tells Files about who may open a file (`FileReaders`, API design 15.2): a staff member opens the file of
 * one of their own documents (purpose 6), so long as the document and their record are both active. Every other
 * purpose, and every other file, is refused here; the Owners and Admins of the Institution never get this far.
 */
@Injectable()
export class PeopleFileReaders extends FileReaders {
  constructor(private readonly documents: DocumentRepository) {
    super();
  }

  mayOpen(tx: Tx, personId: string, file: FileToOpen): Promise<boolean> {
    if (file.purpose !== FilePurpose.StaffDocument) return Promise.resolve(false);
    return this.documents.isOwnFile(tx, file.id, personId);
  }
}
