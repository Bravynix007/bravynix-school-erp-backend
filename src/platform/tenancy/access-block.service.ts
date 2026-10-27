import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { BlockSection } from '../../common/auth/block-section.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { FieldErrorCode } from '../../common/http/error-codes.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { fieldError } from '../../common/validation/field-error.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService, type AuditValues } from '../audit/index.js';
import {
  DatabaseService,
  duplicateOn,
  isDuplicateOn,
  platformTenant,
  type Tx,
} from '../database/index.js';
import {
  BLOCK_SORT_FIELDS,
  type BlockSectionName,
  type CreateAccessBlockDto,
  type ListAccessBlocksQueryDto,
} from './access-block.dto.js';
import { AccessBlockRepository, type AccessBlockRow } from './access-block.repository.js';
import {
  blockResource,
  peopleOfBlocks,
  societyBlockResource,
  type AccessBlockResource,
  type SocietyBlockResource,
} from './access-block.resource.js';
import { InstitutionRepository } from './institution.repository.js';
import { requireActive } from './record-rules.js';
import { ScopeService } from './scope.service.js';
import { SocietyRepository } from './society.repository.js';
import { PersonDirectory } from '../identity/index.js';

const SECTION_CODE: Record<BlockSectionName, BlockSection> = {
  owners: BlockSection.Owners,
  staff: BlockSection.Staff,
  students: BlockSection.Students,
};

function auditView(row: AccessBlockRow): AuditValues {
  return {
    section: row.section,
    institution_id: row.institution_id,
    active: row.lifted_at === null,
  };
}

/**
 * PLT-42 to PLT-44 and SOC-02 (API design 10.4e): Super Admin blocks and
 * unblocks a section of a Society's people, and an Owner reads the blocks of
 * their own Society. Setting or lifting a block commits with its audit entry,
 * which carries the Society and Institution so the Society's Owners see it.
 */
@Injectable()
export class AccessBlockService {
  constructor(
    private readonly database: DatabaseService,
    private readonly blocks: AccessBlockRepository,
    private readonly societies: SocietyRepository,
    private readonly institutions: InstitutionRepository,
    private readonly scope: ScopeService,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** PLT-42: one active block per section, so a second is 409 `DUPLICATE`. */
  async block(principal: Principal, body: CreateAccessBlockDto): Promise<AccessBlockResource> {
    const institutionId = this.institutionOf(body);
    const tenant = platformTenant(principal, body.societyId, institutionId ? [institutionId] : []);
    const row = await this.database
      .transaction(tenant, async (tx) => {
        const society = await this.societies.find(tx, body.societyId);
        if (!society) throw AppException.notFound();
        requireActive(society);
        if (institutionId) {
          const institution = await this.institutions.find(tx, institutionId);
          // An Institution of another Society is as unknown as a missing one.
          if (institution?.society_id !== body.societyId) throw AppException.notFound();
          requireActive(institution);
        }
        const created = await this.blocks.insert(tx, {
          society_id: body.societyId,
          institution_id: institutionId ?? null,
          section: SECTION_CODE[body.section],
          reason: body.reason,
          created_by: principal.personId,
          updated_by: principal.personId,
        });
        await this.record(tx, 'access.block', created, body.reason, { after: auditView(created) });
        return created;
      })
      .catch((error: unknown) => {
        throw isDuplicateOn(error, 'uq_access_blocks_active') ? duplicateOn('section') : error;
      });
    return this.resource(row);
  }

  /** PLT-43: 404 for an unknown block or one already lifted, also when two lifts race. */
  async lift(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const known = await this.database.transaction(platformTenant(principal), (tx) =>
      this.blocks.find(tx, id),
    );
    if (!known) throw AppException.notFound();
    const tenant = platformTenant(
      principal,
      known.society_id,
      known.institution_id ? [known.institution_id] : [],
    );
    await this.database.transaction(tenant, async (tx) => {
      const lifted = await this.blocks.lift(tx, id, principal.personId, this.clock.now());
      if (!lifted) throw AppException.notFound();
      await this.record(tx, 'access.unblock', lifted, null, {
        before: auditView(known),
        after: auditView(lifted),
      });
    });
    return { id, status: 0 };
  }

  /** PLT-44. */
  async list(
    principal: Principal,
    query: ListAccessBlocksQueryDto,
  ): Promise<ApiResult<AccessBlockResource[]>> {
    const sort = parseSort(query.sort, BLOCK_SORT_FIELDS, [
      { field: 'blockedAt', direction: 'desc' },
    ]);
    const { rows, total } = await this.database.transaction(platformTenant(principal), (tx) =>
      this.blocks.page(
        tx,
        {
          q: query.q,
          societyId: query.societyId,
          institutionId: query.institutionId,
          sections: query.section?.map((name) => SECTION_CODE[name]),
        },
        sort,
        query.limit,
        pageOffset(query.page, query.limit),
      ),
    );
    const people = await this.people.describe(peopleOfBlocks(rows));
    return ApiResult.list(
      rows.map((row) => blockResource(row, people)),
      pageMeta(query.page, query.limit, total),
    );
  }

  /** SOC-02: the active blocks of the Owner's own Society, with the reason (the 423 never carries it). */
  async forSociety(principal: Principal): Promise<ApiResult<SocietyBlockResource[]>> {
    const { societyId, tenant } = await this.scope.forPrincipal(principal);
    if (societyId === null) throw AppException.forbidden();
    const rows = await this.database.transaction(tenant, (tx) =>
      this.blocks.activeIn(tx, societyId),
    );
    return ApiResult.list(rows.map(societyBlockResource), null);
  }

  /** `owners` has no Institution; `staff` and `students` need one. */
  private institutionOf(body: CreateAccessBlockDto): string | undefined {
    if (body.section === 'owners') {
      if (body.institutionId !== undefined) {
        throw AppException.validation([
          fieldError('institutionId', FieldErrorCode.FIELD_NOT_ALLOWED),
        ]);
      }
      return undefined;
    }
    // `@IsOptional` lets null through as well as a missing field.
    if (body.institutionId === undefined || body.institutionId === null) {
      throw AppException.validation([fieldError('institutionId', FieldErrorCode.REQUIRED)]);
    }
    return body.institutionId;
  }

  private async resource(row: AccessBlockRow): Promise<AccessBlockResource> {
    return blockResource(row, await this.people.describe(peopleOfBlocks([row])));
  }

  /** The audit entry carries the Society and, for staff and students, the Institution (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    block: AccessBlockRow,
    reason: string | null,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: block.institution_id,
      societyId: block.society_id,
      entityType: 'access_block',
      entityId: block.id,
      ...(reason === null ? {} : { reason }),
      ...values,
    });
  }
}
