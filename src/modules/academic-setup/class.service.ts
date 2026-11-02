import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
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
import type {
  ClassInputDto,
  CreateClassDto,
  CreateClassesDto,
  ListClassesQueryDto,
  UpdateClassDto,
} from './class.dto.js';
import { ClassRepository, type ClassRow, type ClassView } from './class.repository.js';
import { classResource, peopleOf, type ClassResource } from './class.resource.js';
import {
  defaultClassName,
  requireClassAllowed,
  requireNameFits,
  translateClassError,
} from './class.rules.js';
import { SectionRepository } from './section.repository.js';
import { classAuditView, sectionAuditView } from './structure.audit.js';

/**
 * CLS-01 to CLS-05 (API design 10.4j): the classes of one Institution. Society Owners and Institution Admins of the
 * Institution add, change and deactivate; everyone in its scope reads. A class exists only in a category the
 * Institution offers (decision 24) and has a stream only in Pre-University (decision 7). Every write runs in one
 * transaction with its audit entry, and `version` is checked before anything else.
 */
@Injectable()
export class ClassService {
  constructor(
    private readonly database: DatabaseService,
    private readonly classes: ClassRepository,
    private readonly sections: SectionRepository,
    private readonly masters: MasterReferences,
    private readonly scope: ScopeService,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /** CLS-01: the active classes with their section counts. */
  async list(
    principal: Principal,
    query: ListClassesQueryDto,
  ): Promise<ApiResult<ClassResource[]>> {
    const { tenant } = await this.scope.requireInstitution(principal, query.institutionId);
    const rows = await this.database.transaction(tenant, (tx) =>
      this.classes.active(tx, query.institutionId),
    );
    return ApiResult.list(await this.resources(rows), null);
  }

  /** CLS-02. */
  async create(principal: Principal, body: CreateClassDto): Promise<ClassResource> {
    const [created] = await this.createAll(principal, body.institutionId, [body], false);
    return created!;
  }

  /** CLS-03: all of them or none; a refusal names the item (`classes[2].streamName`). */
  async createMany(principal: Principal, body: CreateClassesDto): Promise<ClassResource[]> {
    return this.createAll(principal, body.institutionId, body.classes, true);
  }

  /**
   * CLS-04: `version` first; a request that changes nothing writes nothing. The predefined class and the stream
   * are not editable (a different class is a new class).
   */
  async update(principal: Principal, id: string, body: UpdateClassDto): Promise<ClassResource> {
    const context = await this.contextOf(principal, id);
    const view = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        const changes = changedColumns(current, {
          display_name: body.displayName,
          code: body.code,
        });
        if (Object.keys(changes).length > 0) {
          const updated = await this.classes.update(tx, id, {
            ...changes,
            ...updateStamp(principal.personId),
          });
          await this.record(tx, 'class.updated', updated, {
            before: classAuditView(current),
            after: classAuditView(updated),
          });
        }
        return (await this.classes.views(tx, [id]))[0]!;
      })
      .catch((error: unknown) => {
        throw translateClassError(error, false);
      });
    return (await this.resources([view]))[0]!;
  }

  /**
   * CLS-05: deactivates the class and, with it, its active sections (a section cannot outlive its class); nothing
   * is deleted, and the names are free again. Phase 4 refuses it while students are placed (`HAS_STUDENTS`).
   */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOf(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      for (const section of await this.sections.lockedActive(tx, id)) {
        const closed = await this.sections.update(tx, section.id, {
          status: 0,
          ...updateStamp(principal.personId),
        });
        await this.audit.record(tx, {
          action: 'section.deactivated',
          institutionId: closed.institution_id,
          societyId: closed.society_id,
          entityType: 'section',
          entityId: closed.id,
          before: sectionAuditView(section),
          after: sectionAuditView(closed),
        });
      }
      const updated = await this.classes.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'class.deactivated', updated, {
        before: classAuditView(current),
        after: classAuditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /** Adds the classes in one transaction, in the order given; the answer is in the same order. */
  private async createAll(
    principal: Principal,
    institutionId: string,
    inputs: readonly ClassInputDto[],
    bulk: boolean,
  ): Promise<ClassResource[]> {
    const context = await this.scope.requireInstitution(principal, institutionId);
    const views = await this.database.transaction(context.tenant, async (tx) => {
      const offered = await this.classes.offeredCategories(tx, institutionId);
      const ids: string[] = [];
      for (const [index, input] of inputs.entries()) {
        const prefix = bulk ? `classes[${index}].` : '';
        ids.push(await this.createOne(tx, principal, context, offered, input, prefix));
      }
      const byId = new Map((await this.classes.views(tx, ids)).map((view) => [view.id, view]));
      return ids.map((id) => byId.get(id)!);
    });
    return this.resources(views);
  }

  private async createOne(
    tx: Tx,
    principal: Principal,
    context: InstitutionContext,
    offered: ReadonlySet<string>,
    input: ClassInputDto,
    prefix: string,
  ): Promise<string> {
    const predefined = await this.masters.requirePredefinedClass(
      tx,
      input.predefinedClassId,
      `${prefix}predefinedClassId`,
    );
    const streamName = input.streamName ?? null;
    requireClassAllowed(
      { code: predefined.categoryCode, offered: offered.has(predefined.categoryId) },
      streamName,
      prefix,
    );
    const displayName = input.displayName ?? defaultClassName(predefined.name, streamName);
    requireNameFits(displayName, prefix);
    try {
      const created = await this.classes.insert(tx, {
        id: newId(),
        society_id: context.societyId,
        institution_id: context.institutionId,
        predefined_class_id: predefined.id,
        class_category_id: predefined.categoryId,
        stream_name: streamName,
        display_name: displayName,
        code: input.code ?? null,
        ...insertStamp(principal.personId),
      });
      await this.record(tx, 'class.created', created, { after: classAuditView(created) });
      return created.id;
    } catch (error) {
      throw translateClassError(error, streamName !== null, prefix);
    }
  }

  /**
   * The Institution of a class named by its ID alone, which the caller must reach (404 for a class in another
   * Society, or an Institution outside their scope, and for a deactivated one).
   */
  private async contextOf(principal: Principal, id: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.classes.find(tx, id));
    if (!found || found.status === 0) throw AppException.notFound();
    return this.scope.requireInstitution(principal, found.institution_id);
  }

  /** The class, locked for the change; 404 when it is gone or deactivated. */
  private async lockedActive(tx: Tx, id: string): Promise<ClassRow> {
    const found = await this.classes.find(tx, id, true);
    if (!found || found.status === 0) throw AppException.notFound();
    return found;
  }

  private async resources(views: readonly ClassView[]): Promise<ClassResource[]> {
    const people = await this.people.describe(peopleOf(views));
    return views.map((view) => classResource(view, people));
  }

  /** The entry carries the Society and the Institution, so the Society's Owners see it (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    row: ClassRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: row.institution_id,
      societyId: row.society_id,
      entityType: 'class',
      entityId: row.id,
      ...values,
    });
  }
}
