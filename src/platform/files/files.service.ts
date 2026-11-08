import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { newId } from '../../common/ids/ids.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../audit/index.js';
import { DatabaseService } from '../database/index.js';
import { ScopeService } from '../tenancy/index.js';
import { matchesDeclaredType } from './file-signature.js';
import { MAX_FILE_BYTES, PRIVATE_BUCKET, PURPOSES, type FilePurpose } from './file-purposes.js';
import type { RequestUploadDto } from './files.dto.js';
import { FilesRepository, type FileRow } from './files.repository.js';
import { fileResource, type FileResource } from './files.resource.js';
import { ObjectStorage, type DownloadTicket, type UploadTicket } from './object-storage.js';

/** How long an upload ticket and a download link last (API design 15.1, 15.3). */
const TICKET_SECONDS = 300;
/** A file never confirmed is swept away after this long (DDD 16.3). */
const PENDING_HOURS = 24;
const DAY_MS = 86_400_000;

/** What the client needs to send the file (API design 15.1 step 1). */
export interface UploadGrant {
  fileId: string;
  upload: UploadTicket;
  maxBytes: number;
}

/** Purposes whose name is kept: documents and imports show it, photos do not (DDD 9.12). */
const KEEPS_NAME = new Set<number>([5, 6, 12]);

/** The name as a plain file name: no path, no control characters, at most 255. */
function plainName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, 255);
}

/**
 * FIL-01 to FIL-03 (API design 15): files never pass through the API. A client asks for an upload ticket, sends the
 * file to the store, then confirms; the server reads what arrived, checks its size and first bytes, and only then
 * calls it Ready. Other modules take a Ready file of the right purpose by its ID.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly files: FilesRepository,
    private readonly storage: ObjectStorage,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** FIL-01: 413 over 5 MB, 415 for a type the purpose does not take, 403 for a role the purpose does not allow. */
  async requestUpload(principal: Principal, body: RequestUploadDto): Promise<UploadGrant> {
    const rule = PURPOSES[body.purpose as FilePurpose];
    if (principal.roleCode === null || !rule.uploadRoles.includes(principal.roleCode)) {
      throw AppException.forbidden();
    }
    const context = await this.scope.requireInstitution(principal, body.institutionId);
    if (body.sizeBytes > MAX_FILE_BYTES) {
      throw new AppException(HttpStatus.PAYLOAD_TOO_LARGE, ErrorCode.FILE_TOO_LARGE);
    }
    if (!rule.contentTypes.includes(body.contentType)) {
      throw new AppException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.FILE_TYPE_NOT_ALLOWED);
    }
    const now = this.clock.now();
    const key = `${context.societyId}/${context.institutionId}/${body.purpose}/${newId()}`;
    const file = await this.database.transaction(context.tenant, (tx) =>
      this.files.insert(tx, {
        id: newId(),
        created_by: principal.personId,
        society_id: context.societyId,
        institution_id: context.institutionId,
        storage_bucket: PRIVATE_BUCKET,
        object_key: key,
        purpose: body.purpose,
        content_type: body.contentType,
        size_bytes: body.sizeBytes,
        original_filename: KEEPS_NAME.has(body.purpose) ? plainName(body.fileName) : null,
        delete_after: new Date(now.getTime() + PENDING_HOURS * 3_600_000),
      }),
    );
    const upload = await this.storage.createUpload({
      key,
      contentType: body.contentType,
      maxBytes: MAX_FILE_BYTES,
      expiresAt: new Date(now.getTime() + TICKET_SECONDS * 1000),
    });
    return { fileId: file.id, upload, maxBytes: MAX_FILE_BYTES };
  }

  /**
   * FIL-02: only the uploader confirms, and a file that is not theirs, or is gone, is 404. 422 `UPLOAD_NOT_FOUND`
   * when nothing arrived yet (the file stays Pending, so the client can send it and confirm again); 422
   * `FILE_CHECK_FAILED` when what arrived is not the declared size or type, in which case it is discarded; 409
   * `ALREADY_CONFIRMED` for a second confirm.
   */
  async confirm(principal: Principal, fileId: string): Promise<FileResource> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const file = await this.database.transaction(tenant, (tx) => this.files.find(tx, fileId));
    // 3 Rejected and 4 Deleted files no longer exist as far as a client can tell.
    if (!file || file.created_by !== principal.personId || file.file_status > 2) {
      throw AppException.notFound();
    }
    if (file.file_status === 2) throw alreadyConfirmed();

    const bytes = await this.storage.read(file.object_key);
    if (!bytes) throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.UPLOAD_NOT_FOUND);
    const sound = bytes.length === file.size_bytes && matchesDeclaredType(bytes, file.content_type);
    const now = this.clock.now();
    if (!sound) {
      await this.storage.remove(file.object_key);
      await this.database.transaction(tenant, (tx) =>
        this.files.settlePending(tx, fileId, { file_status: 3, deleted_at: now }),
      );
      throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.FILE_CHECK_FAILED);
    }
    const keepDays = PURPOSES[file.purpose as FilePurpose].keepDays;
    const ready = await this.database.transaction(tenant, (tx) =>
      this.files.settlePending(tx, fileId, {
        file_status: 2,
        confirmed_at: now,
        checksum_sha256: createHash('sha256').update(bytes).digest(),
        delete_after: keepDays === null ? null : new Date(now.getTime() + keepDays * DAY_MS),
      }),
    );
    if (!ready) throw alreadyConfirmed();
    return fileResource(ready);
  }

  /**
   * FIL-03: a five-minute link to a Ready file. The uploader and the Society Owners and Institution Admins of the
   * file's Institution may fetch it; anyone else, and any file that is not Ready, is 404. The links of purposes
   * that hold documents are written to the audit log before the link is made.
   */
  async download(principal: Principal, fileId: string): Promise<DownloadTicket> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const file = await this.database.transaction(tenant, async (tx) => {
      const found = await this.files.find(tx, fileId);
      if (!found || found.file_status !== 2 || !mayFetch(principal, found)) {
        throw AppException.notFound();
      }
      if (PURPOSES[found.purpose as FilePurpose].auditedDownload) {
        await this.audit.record(tx, {
          action: 'file.download',
          societyId: found.society_id,
          institutionId: found.institution_id,
          entityType: 'file',
          entityId: found.id,
        });
      }
      return found;
    });
    return this.storage.createDownload({
      key: file.object_key,
      contentType: file.content_type,
      fileName: file.original_filename,
      expiresAt: new Date(this.clock.now().getTime() + TICKET_SECONDS * 1000),
    });
  }
}

const alreadyConfirmed = (): AppException =>
  new AppException(HttpStatus.CONFLICT, ErrorCode.ALREADY_CONFIRMED);

/** The uploader, or an Owner or Admin who reaches the Institution (row-level security has narrowed the rows to it). */
function mayFetch(principal: Principal, file: FileRow): boolean {
  return (
    file.created_by === principal.personId ||
    principal.roleCode === RoleCode.SocietyOwner ||
    principal.roleCode === RoleCode.InstitutionAdmin
  );
}
