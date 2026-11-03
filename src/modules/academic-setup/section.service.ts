import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { newId } from '../../common/ids/ids.js';
import { requireVersion } from '../../common/http/require-version.js';
import { AuditService, type AuditValues } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { MasterReferences } from '../../platform/masters/index.js';
import { ScopeService, type InstitutionContext } from '../../platform/tenancy/index.js';
import { ClassRepository } from './class.repository.js';
import { translateSectionError } from './class.rules.js';
import type { CreateSectionDto, UpdateSectionDto } from './section.dto.js';
import { SectionRepository, type SectionRow, type SectionView } from './section.repository.js';
import { sectionResource, type SectionResource } from './section.resource.js';
import { sectionAuditEntry, sectionAuditView } from './structure.audit.js';
import { institutionOfActive } from './row-context.js';

/**
 * SEC-01 to SEC-04 (API design 10.4j): the sections of a class. Who may do what is the same as for classes, and
 * every write runs in one transaction with its audit entry. The capacity is a warning only (PRD 7.3): nothing here
 * or in enrolment refuses a student because a section is full.
 */
@Injectable()
export class SectionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sections: SectionRepository,
    private readonly classes: ClassRepository,
    private readonly masters: MasterReferences,
    private readonly scope: ScopeService,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /** SEC-01: the active sections of a class; 404 for a class the caller cannot reach or one that is deactivated. */
  async list(principal: Principal, classId: string): Promise<ApiResult<SectionResource[]>> {
    const context = await this.classContext(principal, classId);
    const views = await this.database.transaction(context.tenant, (tx) =>
      this.sections.active(tx, classId),
    );
    return ApiResult.list(await this.resources(views), null);
  }

  /** SEC-02: 409 `DUPLICATE` on `predefinedSectionId` or `displayName` when an active section of the class has it. */
  async create(principal: Principal, body: CreateSectionDto): Promise<SectionResource> {
    const context = await this.classContext(principal, body.classId);
    const view = await this.database
      .transaction(context.tenant, async (tx) => {
        // The class is locked while the section is added, so it cannot be deactivated at the same time.
        const parent = await this.classes.find(tx, body.classId, true);
        if (!parent || parent.status === 0) throw AppException.notFound();
        const predefined = await this.masters.requirePredefinedSection(
          tx,
          body.predefinedSectionId,
          'predefinedSectionId',
        );
        const created = await this.sections.insert(tx, {
          id: newId(),
          society_id: context.societyId,
          institution_id: context.institutionId,
          class_id: body.classId,
          predefined_section_id: predefined.id,
          display_name: body.displayName ?? predefined.name,
          capacity: body.capacity ?? null,
          ...insertStamp(principal.personId),
        });
        await this.record(tx, 'section.created', created, { after: sectionAuditView(created) });
        return this.sections.viewOf(tx, created.id);
      })
      .catch((error: unknown) => {
        throw translateSectionError(error);
      });
    return (await this.resources([view]))[0]!;
  }

  /** SEC-03: `version` first; a request that changes nothing writes nothing. A deactivated section is 404. */
  async update(principal: Principal, id: string, body: UpdateSectionDto): Promise<SectionResource> {
    const context = await this.contextOf(principal, id);
    const view = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        const changes = changedColumns(current, {
          display_name: body.displayName,
          capacity: body.capacity,
        });
        if (Object.keys(changes).length > 0) {
          const updated = await this.sections.update(tx, id, {
            ...changes,
            ...updateStamp(principal.personId),
          });
          await this.record(tx, 'section.updated', updated, {
            before: sectionAuditView(current),
            after: sectionAuditView(updated),
          });
        }
        return this.sections.viewOf(tx, id);
      })
      .catch((error: unknown) => {
        throw translateSectionError(error);
      });
    return (await this.resources([view]))[0]!;
  }

  /** SEC-04: deactivates; nothing is deleted, and the name is free again. Phase 4 refuses it while students are placed. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOf(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      const updated = await this.sections.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'section.deactivated', updated, {
        before: sectionAuditView(current),
        after: sectionAuditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /** The Institution of an active class named by its ID, which the caller must reach (404 otherwise). */
  private async classContext(principal: Principal, classId: string): Promise<InstitutionContext> {
    return institutionOfActive(this.scope, this.database, principal, (tx) =>
      this.classes.find(tx, classId),
    );
  }

  /** The Institution of an active section named by its ID alone (404 as for a class). */
  private async contextOf(principal: Principal, id: string): Promise<InstitutionContext> {
    return institutionOfActive(this.scope, this.database, principal, (tx) =>
      this.sections.find(tx, id),
    );
  }

  /** The section, locked for the change; 404 when it is gone or deactivated. */
  private async lockedActive(tx: Tx, id: string): Promise<SectionRow> {
    const found = await this.sections.find(tx, id, true);
    if (!found || found.status === 0) throw AppException.notFound();
    return found;
  }

  private async resources(views: readonly SectionView[]): Promise<SectionResource[]> {
    const people = await this.people.describe(authorIdsOf(views));
    return views.map((view) => sectionResource(view, people));
  }

  private record(
    tx: Tx,
    action: string,
    row: SectionRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, sectionAuditEntry(action, row, values));
  }
}
