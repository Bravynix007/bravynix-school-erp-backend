import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { AppException } from '../../common/http/app-exception.js';
import { newId } from '../../common/ids/ids.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { requireVersion } from '../../common/http/require-version.js';
import { AuditService, type AuditValues } from '../../platform/audit/index.js';
import {
  DatabaseService,
  duplicateOn,
  insertStamp,
  isDuplicateOn,
  updateStamp,
  type TenantContext,
  type Tx,
} from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import type { CreateSubjectDto, UpdateSubjectDto } from './subject.dto.js';
import { SubjectRepository, type SubjectChanges, type SubjectRow } from './subject.repository.js';
import { subjectResource, type SubjectResource } from './subject.resource.js';
import { TeachingStaff } from './teaching-staff.js';

/** What the audit log keeps of a subject. */
function auditView(row: SubjectRow): AuditValues {
  return { name: row.name, code: row.code, status: row.status };
}

/** A unique violation on the Society's name or code is 409 `DUPLICATE` on that field. */
function translate(error: unknown): unknown {
  if (isDuplicateOn(error, 'uq_subjects_society_name')) return duplicateOn('name');
  if (isDuplicateOn(error, 'uq_subjects_society_code')) return duplicateOn('code');
  return error;
}

/**
 * SUB-01 to SUB-04 (API design 10.4i): the Society's subjects, one list shared by its Institutions. Society
 * Owners and Institution Admins add, change and deactivate (owner decision, 2 Nov 2026: an Admin's change applies
 * to every Institution of the Society, and the audit entry names who made it); everyone in the Society reads.
 */
@Injectable()
export class SubjectService {
  constructor(
    private readonly database: DatabaseService,
    private readonly subjects: SubjectRepository,
    private readonly people: PersonDirectory,
    private readonly teaching: TeachingStaff,
    private readonly audit: AuditService,
  ) {}

  /** SUB-01: the active subjects by name. A teacher reads only the subjects they can teach (API design 10.4i). */
  async list(principal: Principal): Promise<ApiResult<SubjectResource[]>> {
    const { tenant, societyId } = this.societyOf(principal);
    const rows = await this.database.transaction(tenant, async (tx) => {
      if (principal.roleCode !== RoleCode.TeacherStaff) return this.subjects.active(tx, societyId);
      const own = await this.teaching.ownSubjectIds(tx, principal.personId);
      return own.size === 0 ? [] : this.subjects.active(tx, societyId, [...own]);
    });
    const people = await this.people.describe(authorIdsOf(rows));
    return ApiResult.list(
      rows.map((row) => subjectResource(row, people)),
      null,
    );
  }

  /** SUB-02: 409 `DUPLICATE` on `name` or `code` when an active subject of the Society has it. */
  async create(principal: Principal, body: CreateSubjectDto): Promise<SubjectResource> {
    const { tenant, societyId } = this.societyOf(principal);
    const row = await this.database
      .transaction(tenant, async (tx) => {
        const created = await this.subjects.insert(tx, {
          id: newId(),
          society_id: societyId,
          name: body.name,
          code: body.code ?? null,
          ...insertStamp(principal.personId),
        });
        await this.record(tx, 'subject.created', created, { after: auditView(created) });
        return created;
      })
      .catch((error: unknown) => {
        throw translate(error);
      });
    return this.resource(row);
  }

  /** SUB-03: `version` is checked first; a request that changes nothing writes nothing. A deactivated subject is 404. */
  async update(principal: Principal, id: string, body: UpdateSubjectDto): Promise<SubjectResource> {
    const { tenant } = this.societyOf(principal);
    const row = await this.database
      .transaction(tenant, async (tx) => {
        const current = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        const wanted: SubjectChanges = {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.code === undefined ? {} : { code: body.code }),
        };
        const changes = changedColumns(current, wanted) as SubjectChanges;
        if (Object.keys(changes).length === 0) return current;
        const updated = await this.subjects.update(tx, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        await this.record(tx, 'subject.updated', updated, {
          before: auditView(current),
          after: auditView(updated),
        });
        return updated;
      })
      .catch((error: unknown) => {
        throw translate(error);
      });
    return this.resource(row);
  }

  /** SUB-04: deactivates; nothing is deleted, and the name and code are free again. 404 when already deactivated. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const { tenant } = this.societyOf(principal);
    await this.database.transaction(tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      const updated = await this.subjects.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'subject.deactivated', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /** The caller's Society, which row-level security then limits every query to; a caller with none is 403. */
  private societyOf(principal: Principal): { tenant: TenantContext; societyId: string } {
    const { personId, roleCode, societyId } = principal;
    if (societyId === null) throw AppException.forbidden();
    return { tenant: { personId, roleCode, societyId }, societyId };
  }

  /** The subject, locked for the change; 404 when it is another Society's (the database hides it), gone or deactivated. */
  private async lockedActive(tx: Tx, id: string): Promise<SubjectRow> {
    const row = await this.subjects.find(tx, id, true);
    if (!row || row.status === 0) throw AppException.notFound();
    return row;
  }

  private async resource(row: SubjectRow): Promise<SubjectResource> {
    return subjectResource(row, await this.people.describe(authorIdsOf([row])));
  }

  /** The entry carries the Society and no Institution: a subject belongs to the whole Society (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    subject: SubjectRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: null,
      societyId: subject.society_id,
      entityType: 'subject',
      entityId: subject.id,
      ...values,
    });
  }
}
