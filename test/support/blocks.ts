import { sql, type Kysely } from 'kysely';
import { personaByKey } from '../../src/seeds/two-worlds.js';

const superAdmin = personaByKey('SA1');

/**
 * Sets or lifts the active block of this section directly, as the table owner
 * acting as Super Admin, so a test can arrange state without the API. The
 * table has no delete policy, so a test resets it with `clearBlocks`.
 */
export const setBlock = (
  ownerDb: Kysely<unknown>,
  societyId: string,
  institutionId: string | null,
  section: 1 | 2 | 3,
  on: boolean,
) =>
  ownerDb.transaction().execute(async (tx) => {
    await sql`select set_config('app.role_code', '1', true)`.execute(tx);
    if (on) {
      await sql`
        insert into access_blocks (society_id, institution_id, section, reason, created_by)
        values (${societyId}, ${institutionId}, ${section}, 'Dues unpaid', ${superAdmin.id})
      `.execute(tx);
    } else {
      await sql`
        update access_blocks set lifted_at = now(), lifted_by = ${superAdmin.id}
        where society_id = ${societyId} and section = ${section} and lifted_at is null
          and institution_id is not distinct from ${institutionId}
      `.execute(tx);
    }
  });

/** Removes every block, history included. Truncate is not subject to row-level security. */
export const clearBlocks = (ownerDb: Kysely<unknown>) =>
  sql`truncate table access_blocks`.execute(ownerDb);
