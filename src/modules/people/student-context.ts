import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { DatabaseService, type Tx } from '../../platform/database/index.js';
import { ScopeService, type InstitutionContext } from '../../platform/tenancy/index.js';
import { StudentRepository, type StudentRow } from './student.repository.js';

/**
 * The Institution context of a request about one student (STU-03 to STU-08): the child's Institution,
 * which the caller must reach.
 */
@Injectable()
export class StudentContext {
  constructor(
    private readonly database: DatabaseService,
    private readonly students: StudentRepository,
    private readonly scope: ScopeService,
  ) {}

  /** 404 for a student who does not exist or is at no Institution the caller reaches (SDD 12.4). */
  async of(principal: Principal, id: string): Promise<InstitutionContext> {
    const scope = await this.scope.forPrincipal(principal);
    const institutionId = await this.database.transaction(
      scope.tenant,
      async (tx) => (await this.students.find(tx, id))?.institution_id,
    );
    if (!institutionId) throw AppException.notFound();
    return this.scope.requireInstitution(principal, institutionId);
  }

  /** The student, locked for the change; 404 when gone or deactivated. */
  async lockedActive(tx: Tx, id: string): Promise<StudentRow> {
    const row = await this.students.find(tx, id, true);
    if (!row || row.status === 0) throw AppException.notFound();
    return row;
  }
}
