import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
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
import { SectionStudents } from './section-students.js';
import { TeachingStaff, type ClassTeacherRef } from './teaching-staff.js';

/** What a section list shows besides the rows themselves. */
interface SectionExtras {
  classTeachers: ReadonlyMap<string, ClassTeacherRef>;
  counts: ReadonlyMap<string, number>;
}

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
    private readonly teaching: TeachingStaff,
    private readonly students: SectionStudents,
    private readonly audit: AuditService,
  ) {}

  /**
   * SEC-01: the active sections of a class, each with its class teacher; 404 for a class the caller cannot reach or
   * one that is deactivated. A teacher reads only the sections they lead or teach this year, and 403 `NOT_ASSIGNED`
   * when the class has none (API design 6.4, 10.4j).
   */
  async list(principal: Principal, classId: string): Promise<ApiResult<SectionResource[]>> {
    const context = await this.classContext(principal, classId);
    const { views, extras } = await this.database.transaction(context.tenant, async (tx) => {
      const own =
        principal.roleCode === RoleCode.TeacherStaff
          ? [...(await this.teaching.ownSectionIds(tx, principal.personId, context.institutionId))]
          : undefined;
      const found = own?.length === 0 ? [] : await this.sections.active(tx, classId, own);
      if (own && found.length === 0) throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
      return { views: found, extras: await this.extrasOf(tx, context, found) };
    });
    return ApiResult.list(await this.resources(views, extras), null);
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
    // A section that was just made has no class teacher and no students.
    return (await this.resources([view], { classTeachers: new Map(), counts: new Map() }))[0]!;
  }

  /** SEC-03: `version` first; a request that changes nothing writes nothing. A deactivated section is 404. */
  async update(principal: Principal, id: string, body: UpdateSectionDto): Promise<SectionResource> {
    const context = await this.contextOf(principal, id);
    const { view, extras } = await this.database
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
        const updated = await this.sections.viewOf(tx, id);
        return { view: updated, extras: await this.extrasOf(tx, context, [updated]) };
      })
      .catch((error: unknown) => {
        throw translateSectionError(error);
      });
    return (await this.resources([view], extras))[0]!;
  }

  /**
   * SEC-04: deactivates; nothing is deleted, and the name is free again. 409 `HAS_STUDENTS` while students sit in it:
   * the section is locked first, so nobody can be placed in it between the count and the change.
   */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOf(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      const counts = await this.students.countsOf(tx, [id]);
      if ((counts.get(id) ?? 0) > 0) throw AppException.conflict(ErrorCode.HAS_STUDENTS);
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

  /** Who leads each of these sections in the Institution's current year, and how many students sit in them. */
  private async extrasOf(
    tx: Tx,
    context: InstitutionContext,
    views: readonly SectionView[],
  ): Promise<SectionExtras> {
    const ids = views.map((view) => view.id);
    if (ids.length === 0) return { classTeachers: new Map(), counts: new Map() };
    return {
      classTeachers: await this.teaching.classTeachers(tx, context.institutionId, ids),
      counts: await this.students.countsOf(tx, ids),
    };
  }

  private async resources(
    views: readonly SectionView[],
    extras: SectionExtras,
  ): Promise<SectionResource[]> {
    const people = await this.people.describe(authorIdsOf(views));
    return views.map((view) =>
      sectionResource(
        view,
        people,
        extras.classTeachers.get(view.id) ?? null,
        extras.counts.get(view.id) ?? 0,
      ),
    );
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
