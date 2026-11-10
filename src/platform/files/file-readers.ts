import type { Tx } from '../database/index.js';

/** The file a caller asks to open, as a reader of its purpose needs to know it. */
export interface FileToOpen {
  id: string;
  purpose: number;
}

/**
 * Who, besides the Owners and Admins of its Institution, may open a file (API design 15.2). Files knows no record, so
 * the module that owns a purpose answers for it (SDD 9.3 rule 7): People says whether a staff member may open the
 * file of one of their own documents. A purpose nobody answers for is refused, and a refusal is a 404, as for any
 * file the caller does not reach. The call runs in the caller's transaction, under row-level security.
 */
export abstract class FileReaders {
  abstract mayOpen(tx: Tx, personId: string, file: FileToOpen): Promise<boolean>;
}
