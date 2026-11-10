import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { ApiResult } from '../../common/http/api-result.js';
import { newId } from '../../common/ids/ids.js';
import { AuditService } from '../../platform/audit/index.js';
import { DatabaseService, insertStamp, isDuplicateOn } from '../../platform/database/index.js';
import { FileDirectory, FilePurpose } from '../../platform/files/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { ScopeService } from '../../platform/tenancy/index.js';
import { DocumentRepository, type DocumentRow } from './document.repository.js';
import type { CreateStaffDocumentDto } from './document.dto.js';
import { documentResource, type DocumentResource } from './document.resource.js';
import { StaffContext } from './staff-context.js';

/** The unique key that attaches a file once (DDD 9.6). */
const ONE_DOCUMENT_PER_FILE = 'uq_documents_file';

/** The owner of a staff document, as the audit log and the screens see it. */
const AUDIT_ENTITY = 'document';

/**
 * STF-14, STF-15 and DOC-03 (API design 9.5, 9.7): the files attached to a staff member, such as an appointment letter.
 * The file is uploaded first (FIL-01, FIL-02) as purpose 6 for the staff member's home Institution; a link to it comes
 * from FIL-03, which is audited.
 */
@Injectable()
export class DocumentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly documents: DocumentRepository,
    private readonly context: StaffContext,
    private readonly scope: ScopeService,
    private readonly files: FileDirectory,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /**
   * STF-14: the active documents of a staff member, newest first, `meta: null`. A teacher reads their own record only
   * (404 for another), an admin the records of Institutions they reach; a deactivated record keeps its documents.
   */
  async list(principal: Principal, staffMemberId: string): Promise<ApiResult<DocumentResource[]>> {
    const context = await this.context.of(principal, staffMemberId);
    const rows = await this.database.transaction(context.tenant, (tx) =>
      this.documents.ofStaff(tx, staffMemberId),
    );
    return ApiResult.list(await this.resources(context.tenant, rows), null);
  }

  /**
   * STF-15: attaches a file to an active staff member. The file must be Ready, of purpose 6 and made for the staff
   * member's home Institution (400 `INVALID_VALUE` on `fileId`; 404 for one the caller cannot see). 409 `DUPLICATE`
   * when the file is already attached to a document, deactivated ones included.
   */
  async create(
    principal: Principal,
    staffMemberId: string,
    body: CreateStaffDocumentDto,
  ): Promise<DocumentResource> {
    const context = await this.context.of(principal, staffMemberId);
    const row = await this.database
      .transaction(context.tenant, async (tx) => {
        const staff = await this.context.lockedActive(tx, staffMemberId);
        await this.files.requireReady(
          tx,
          body.fileId,
          { purpose: FilePurpose.StaffDocument, institutionId: staff.home_institution_id },
          'fileId',
        );
        const created = await this.documents.insert(tx, {
          id: newId(),
          society_id: staff.society_id,
          institution_id: staff.home_institution_id,
          owner_type: 2,
          staff_member_id: staffMemberId,
          title: body.title,
          file_id: body.fileId,
          ...insertStamp(principal.personId),
        });
        await this.audit.record(tx, {
          action: 'document.created',
          institutionId: created.institution_id,
          entityType: AUDIT_ENTITY,
          entityId: created.id,
          after: { staffMemberId, title: created.title, fileId: created.file_id },
        });
        return created;
      })
      .catch((error: unknown) => {
        if (isDuplicateOn(error, ONE_DOCUMENT_PER_FILE)) {
          throw AppException.conflict(ErrorCode.DUPLICATE);
        }
        throw error;
      });
    const [resource] = await this.resources(context.tenant, [row]);
    if (!resource) throw new Error(`Document ${row.id} was made but cannot be shown`);
    return resource;
  }

  /**
   * DOC-03: deactivates a document (`status` 0); nothing is deleted, and the file is removed by the sweep after 30
   * days. 404 for a document that is not found, is already deactivated or belongs to an Institution the caller does not
   * reach.
   */
  async deactivate(principal: Principal, documentId: string): Promise<{ id: string; status: 0 }> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) =>
      this.documents.find(tx, documentId),
    );
    if (!found) throw AppException.notFound();
    const context = await this.scope.requireInstitution(principal, found.institution_id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.documents.find(tx, documentId, true);
      if (!current || current.status === 0) throw AppException.notFound();
      await this.documents.deactivate(tx, documentId, principal.personId);
      await this.audit.record(tx, {
        action: 'document.deactivated',
        institutionId: current.institution_id,
        entityType: AUDIT_ENTITY,
        entityId: documentId,
        before: { status: 1 },
        after: { status: 0 },
      });
    });
    return { id: documentId, status: 0 };
  }

  private async resources(
    tenant: Parameters<DatabaseService['transaction']>[0],
    rows: DocumentRow[],
  ): Promise<DocumentResource[]> {
    if (rows.length === 0) return [];
    const [briefs, people] = await Promise.all([
      this.database.transaction(tenant, (tx) =>
        this.files.briefs(
          tx,
          rows.map((row) => row.file_id),
        ),
      ),
      this.people.describe(authorIdsOf(rows)),
    ]);
    return rows.map((row) => {
      const file = briefs.get(row.file_id);
      if (!file) throw new Error(`Document ${row.id} points at a file that cannot be read`);
      return documentResource(row, file, people);
    });
  }
}
