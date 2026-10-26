import { sql, type Kysely } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';
import { signInMobile } from './sessions.js';
import type { TestApp } from './test-app.js';

export interface SignedInPerson {
  person: string;
  email: string;
  /** The access token of the session they signed in with, already in its only context. */
  token: string;
  contexts: { roleCode: number; societyId: string | null }[];
}

/**
 * People with grants in scratch Societies, signed in on a phone, for tests of
 * the platform and tenant endpoints. `cleanup` removes them again; call it
 * after the sessions and grants are gone (`clearLoginState`, then
 * `removeScratchSocieties`). `db` connects as the table owner.
 */
export class PlatformFixtures {
  private readonly people: string[] = [];

  constructor(
    private readonly t: TestApp,
    private readonly db: Kysely<unknown>,
  ) {}

  /** A Society Owner of that Society. */
  async owner(societyId: string): Promise<SignedInPerson> {
    return this.signedIn(
      (person) =>
        sql`insert into role_assignments (user_id, role_code, society_id, seat_no)
          values (${person}, 2, ${societyId}, 1)`,
    );
  }

  /** An Institution Admin of those Institutions, all in one Society. */
  async institutionAdmin(
    societyId: string,
    institutionIds: readonly string[],
  ): Promise<SignedInPerson> {
    return this.signedIn(
      (person) =>
        sql`insert into role_assignments (user_id, role_code, society_id, institution_id, staff_member_id)
          select ${person}, 3, ${societyId}, id, gen_random_uuid()
          from unnest(${sql.val(institutionIds)}::uuid[]) as id`,
    );
  }

  async cleanup(): Promise<void> {
    for (const person of this.people.splice(0)) {
      await sql`delete from users where id = ${person}`.execute(this.db);
    }
  }

  private async signedIn(
    grant: (person: string) => ReturnType<typeof sql>,
  ): Promise<SignedInPerson> {
    const person = newId();
    const email = `${person}@two-worlds.test`;
    this.people.push(person);
    await sql`insert into users (id, email) values (${person}, ${email})`.execute(this.db);
    await grant(person).execute(this.db);
    const login = await signInMobile(this.t, email);
    return { person, email, token: login.accessToken, contexts: login.contexts };
  }
}
