import { Injectable } from '@nestjs/common';
import { RoleName, type RoleCode } from '../../common/auth/roles.js';
import { DatabaseService, type Db } from '../database/index.js';

/** The person shape of an author stamp (API design 7.6). */
export interface PersonRef {
  id: string;
  displayName: string;
  roleName: string | null;
}

/**
 * Who a person is, for other modules' author stamps. The `users` and
 * `role_assignments` tables stay private to Identity (SDD 9.3 rule 1).
 */
@Injectable()
export class PersonDirectory {
  constructor(private readonly database: DatabaseService) {}

  /**
   * The people with these IDs, by ID. A person who has since left still
   * shows their name. `roleName` is the role they hold now, the highest if
   * several, else the one they held last, and `null` for a person who never
   * held a role granted here (staff and parents are named by the People module).
   */
  async describe(ids: readonly (string | null)[], db: Db = this.database.db) {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    const people = new Map<string, PersonRef>();
    if (wanted.length === 0) return people;
    const users = await db
      .selectFrom('users')
      .select(['id', 'email', 'first_name', 'last_name'])
      .where('id', 'in', wanted)
      .execute();
    const grants = await db
      .selectFrom('role_assignments')
      .select(['user_id', 'role_code', 'revoked_at'])
      .where('user_id', 'in', wanted)
      .orderBy('created_at', 'desc')
      .execute();
    for (const user of users) {
      const mine = grants.filter((grant) => grant.user_id === user.id);
      const held = mine.filter((grant) => grant.revoked_at === null);
      const role = held.length
        ? Math.min(...held.map((grant) => grant.role_code))
        : mine[0]?.role_code;
      people.set(user.id, {
        id: user.id,
        displayName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
        roleName: role === undefined ? null : (RoleName[role as RoleCode] ?? null),
      });
    }
    return people;
  }
}
