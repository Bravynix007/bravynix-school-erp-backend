import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import type { DatabaseService } from '../database/index.js';
import { GrantDirectory } from './grant-directory.js';
import type { SessionRepository } from './session.repository.js';

const build = () => {
  const { tx, queries } = sqlRecorder();
  const directory = new GrantDirectory(
    { db: tx } as unknown as DatabaseService,
    {} as SessionRepository,
  );
  return { directory, queries };
};

describe('GrantDirectory.adminUserIds', () => {
  it('reads the active Admin grants of one Institution, each person once', async () => {
    const { directory, queries } = build();
    expect(await directory.adminUserIds('society-1', 'inst-1')).toEqual([]);
    const { sql, parameters } = queries[0]!;
    expect(sql).toMatch(/^select distinct "user_id" from "role_assignments"/);
    expect(sql).toContain('"role_code" = $1 and "society_id" = $2 and "revoked_at" is null');
    expect(sql).toContain('"institution_id" = $3');
    expect(parameters).toEqual([3, 'society-1', 'inst-1']);
  });

  it('reads those of every Institution of the Society for no Institution', async () => {
    const { directory, queries } = build();
    await directory.adminUserIds('society-1', null);
    expect(queries[0]!.sql).not.toContain('institution_id');
    expect(queries[0]!.parameters).toEqual([3, 'society-1']);
  });
});
