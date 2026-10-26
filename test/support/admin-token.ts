import { sql, type Kysely } from 'kysely';
import { TokenService } from '../../src/platform/identity/token.service.js';
import type { TestApp } from './test-app.js';

/**
 * An access token for a Super Admin console session, made without the sign-in
 * steps (those are tested on their own). `db` connects as the table owner.
 */
export async function superAdminToken(
  t: TestApp,
  db: Kysely<unknown>,
  personId: string,
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into auth_sessions (user_id, client_type, active_role_code, idle_expires_at, absolute_expires_at)
    values (${personId}, 2, 1, now() + interval '1 hour', now() + interval '1 hour') returning id
  `.execute(db);
  const signed = await t.app
    .get(TokenService)
    .signAccessToken(
      { personId, sessionId: rows[0]!.id, roleCode: 1, societyId: null, clientType: 'console' },
      t.clock.now(),
    );
  return signed.token;
}
