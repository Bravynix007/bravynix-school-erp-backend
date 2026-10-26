import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../audit/index.js';
import { DatabaseService, platformTenant, type Tx } from '../database/index.js';
import {
  AccountDirectory,
  GrantDirectory,
  maskEmail,
  OWNER_SORT_FIELDS,
  type GrantedPerson,
  type NewPersonDto,
  type SeatKind,
} from '../identity/index.js';
import { requireActive } from './record-rules.js';
import type { ListOwnersQueryDto } from './society-owner.dto.js';
import {
  ownerResource,
  ownerSummary,
  type SocietyOwnerResource,
  type SocietyOwnerSummary,
} from './society-owner.resource.js';
import { SocietyRepository, type SocietyRow } from './society.repository.js';

/** Why an Owner's grant was revoked by a Super Admin. */
const OWNER_REMOVED = 'owner_removed';

const ownerSeat = (societyId: string): SeatKind => ({ roleCode: 2, societyId });

/**
 * PLT-09 to PLT-11 (API design 10.4d): Super Admin adds and removes the Owners
 * of a Society, at most three. The grant and its audit entry commit together,
 * and the audit entry carries the Society's ID, so its Owners see it in AUD-01.
 */
@Injectable()
export class SocietyOwnerService {
  constructor(
    private readonly database: DatabaseService,
    private readonly societies: SocietyRepository,
    private readonly directory: AccountDirectory,
    private readonly grants: GrantDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async add(
    principal: Principal,
    societyId: string,
    body: NewPersonDto,
  ): Promise<SocietyOwnerResource> {
    const { society, person } = await this.database.transaction(
      platformTenant(principal, societyId),
      async (tx) => {
        const found = await this.societies.find(tx, societyId, true);
        if (!found) throw AppException.notFound();
        requireActive(found);
        return { society: found, person: await this.addIn(tx, principal, found, body) };
      },
    );
    this.welcome(person, society);
    return ownerResource(person, societyId);
  }

  /** Adds an Owner in the caller's transaction, for PLT-03 as well as PLT-09. The welcome mail is the caller's, after the commit. */
  async addIn(
    tx: Tx,
    principal: Principal,
    society: SocietyRow,
    body: NewPersonDto,
  ): Promise<GrantedPerson> {
    const person = await this.directory.grant(
      tx,
      ownerSeat(society.id),
      body,
      principal.personId,
      this.clock.now(),
    );
    await this.audit.record(tx, {
      action: 'owner.add',
      institutionId: null,
      societyId: society.id,
      entityType: 'user',
      entityId: person.id,
      after: { email: maskEmail(person.email), seat_no: person.seatNo },
    });
    return person;
  }

  welcome(person: GrantedPerson, society: SocietyRow): void {
    this.directory.welcome(person, ownerSeat(society.id), society.name);
  }

  async remove(
    principal: Principal,
    societyId: string,
    userId: string,
  ): Promise<{ id: string; status: 0 }> {
    await this.database.transaction(platformTenant(principal, societyId), async (tx) => {
      const society = await this.societies.find(tx, societyId, true);
      if (!society) throw AppException.notFound();
      const sessionsEnded = await this.directory.revoke(
        tx,
        ownerSeat(societyId),
        userId,
        principal.personId,
        OWNER_REMOVED,
        this.clock.now(),
      );
      await this.audit.record(tx, {
        action: 'owner.remove',
        institutionId: null,
        societyId,
        entityType: 'user',
        entityId: userId,
        after: { sessions_ended: sessionsEnded },
      });
    });
    return { id: userId, status: 0 };
  }

  async list(
    principal: Principal,
    query: ListOwnersQueryDto,
  ): Promise<ApiResult<SocietyOwnerSummary[]>> {
    const sort = parseSort(query.sort, OWNER_SORT_FIELDS, [{ field: 'name', direction: 'asc' }]);
    const { rows, total } = await this.grants.ownersPage(
      { q: query.q, societyId: query.societyId },
      sort,
      query.limit,
      pageOffset(query.page, query.limit),
    );
    const societies = await this.database.transaction(platformTenant(principal), (tx) =>
      this.societies.refs(tx, [...new Set(rows.map((row) => row.societyId))]),
    );
    return ApiResult.list(
      rows.map((row) => ownerSummary(row, societies)),
      pageMeta(query.page, query.limit, total),
    );
  }
}
