import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { TenantContext, Tx } from '../database/index.js';

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
 *
 * A parent has no Institution scope, so People also names the child a file belongs to (`parentTenant`): the tenant
 * that reads that child's rows and no others, or 404 / 403 / 423 as for any request about that child.
 */
export abstract class FileReaders {
  abstract mayOpen(tx: Tx, personId: string, file: FileToOpen): Promise<boolean>;
  abstract parentTenant(principal: Principal, fileId: string): Promise<TenantContext>;
}
