import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { BlockSection } from '../../common/auth/block-section.js';
import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { GrantDirectory, type GuardedChild } from '../../platform/identity/index.js';
import type { InstitutionContext } from '../../platform/tenancy/index.js';

/**
 * Tenant scope for a parent (API design 5.4, 6.4): the child a request names, checked against the children the
 * caller guards, read afresh on every request so a link that ended, a child deactivated or a block lifted takes
 * effect on the next call. A child who is not the caller's is 404 and never admits the record exists (SDD 12.4);
 * a child whose Institution has its students blocked is 423 `SECTION_BLOCKED`, and a child blocked from the profile
 * is 403 `CHILD_ACCESS_BLOCKED` (DDD D-02), each on that child only: the siblings keep working.
 *
 * The result is the same shape as an Institution context, so the reads that serve both staff and parents run
 * unchanged. Its tenant names the one child (`childIds`) and no Institution, so only the policies written for a
 * parent's own child match.
 */
@Injectable()
export class ChildAccess {
  /** One principal object lives for one request, so this memoises per request. */
  private readonly children = new WeakMap<Principal, Promise<readonly GuardedChild[]>>();

  constructor(private readonly grants: GrantDirectory) {}

  async of(principal: Principal, studentId: string): Promise<InstitutionContext> {
    if (principal.roleCode !== RoleCode.StudentParent) throw AppException.forbidden();
    const child = (await this.guarded(principal)).find((found) => found.studentId === studentId);
    if (!child) throw AppException.notFound();
    if (child.studentsBlocked) throw AppException.sectionBlocked(BlockSection.Students);
    if (child.childBlocked) throw AppException.forbidden(ErrorCode.CHILD_ACCESS_BLOCKED);
    return {
      institutionId: child.institutionId,
      societyId: child.societyId,
      tenant: {
        personId: principal.personId,
        roleCode: RoleCode.StudentParent,
        childIds: [studentId],
      },
    };
  }

  private guarded(principal: Principal): Promise<readonly GuardedChild[]> {
    let found = this.children.get(principal);
    if (!found) {
      found = this.grants.guardedChildren(principal.personId);
      this.children.set(principal, found);
    }
    return found;
  }
}
