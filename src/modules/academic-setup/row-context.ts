import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { InstitutionContext, ScopeService } from '../../platform/tenancy/index.js';

/**
 * The Institution of a record named by its ID alone (a year, a class, a section), which the caller must reach:
 * 404 for a record in another Society or an Institution outside their scope, and for a deactivated one, so nothing
 * says whether it exists. `find` reads the record inside the caller's own tenant.
 */
export async function institutionOfActive(
  scope: ScopeService,
  database: DatabaseService,
  principal: Principal,
  find: (tx: Tx) => Promise<{ institution_id: string; status: number } | undefined>,
): Promise<InstitutionContext> {
  const { tenant } = await scope.forPrincipal(principal);
  const found = await database.transaction(tenant, find);
  if (!found || found.status === 0) throw AppException.notFound();
  return scope.requireInstitution(principal, found.institution_id);
}
