import { sql, type Kysely } from 'kysely';
import { personas, societies, type AccountStatus } from './two-worlds.js';

const STATUS_CODE: Record<AccountStatus, number> = {
  inactive: 0,
  active: 1,
  blocked: 2,
  pending: 3,
};

/**
 * Writes the two-worlds personas as `users`, and their Super Admin and
 * Society Owner grants as `role_assignments`. Role 3 grants need staff
 * records and Institutions, so they join when those tables exist.
 *
 * Safe to run twice: rows are keyed by their fixed IDs. Never holds a
 * password or a key: login is by email code only.
 */
export async function writeIdentitySeed(db: Kysely<unknown>): Promise<void> {
  for (const p of personas) {
    const [firstName, ...rest] = p.displayName.split(' ');
    const status = STATUS_CODE[p.status];
    await sql`
      insert into users (id, email, first_name, last_name, account_status, blocked_at, block_reason)
      values (
        ${p.id}, ${p.email}, ${firstName ?? null}, ${rest.join(' ') || null}, ${status},
        ${status === 2 ? sql`now()` : null}, ${status === 2 ? 'Seeded blocked account' : null}
      )
      on conflict (id) do nothing
    `.execute(db);
  }

  const seats = new Map<string, number>();
  for (const p of personas) {
    for (const grant of p.grants) {
      if (grant.role !== 1 && grant.role !== 2) continue;
      const society = grant.society ? societies.find((s) => s.key === grant.society) : undefined;
      const scope = society?.id ?? 'platform';
      const seat = (seats.get(scope) ?? 0) + 1;
      seats.set(scope, seat);
      await sql`
        insert into role_assignments (user_id, role_code, society_id, seat_no)
        select ${p.id}, ${grant.role}, ${society?.id ?? null}, ${seat}
        where not exists (
          select 1 from role_assignments
          where user_id = ${p.id} and role_code = ${grant.role} and revoked_at is null
        )
      `.execute(db);
    }
  }
}
