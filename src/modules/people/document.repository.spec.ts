import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { DocumentRepository } from './document.repository.js';

const repository = new DocumentRepository();

describe('DocumentRepository', () => {
  it('finds a document, locking it when it is about to change', async () => {
    const plain = sqlRecorder();
    await repository.find(plain.tx, 'doc-1');
    expect(plain.queries[0]!.sql).not.toContain('for update');
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'doc-1', true);
    expect(locked.queries[0]!.sql).toMatch(/for update$/);
  });

  it('lists the active documents of a staff member, newest first', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.ofStaff(tx, 'staff-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"staff_member_id" = $1 and "status" = $2');
    expect(sql).toContain('order by "created_at" desc, "id" desc');
    expect(parameters).toEqual(['staff-1', 1]);
  });

  it('asks whether a file is that of an active document of the person’s own active record', async () => {
    const { tx, queries } = sqlRecorder();
    expect(await repository.isOwnFile(tx, 'file-1', 'user-1')).toBe(false);
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('inner join "staff_members" as "s" on "s"."id" = "d"."staff_member_id"');
    expect(sql).toContain('"d"."file_id" = $1 and "d"."status" = $2');
    expect(sql).toContain('"s"."user_id" = $3 and "s"."status" = $4');
    expect(parameters).toEqual(['file-1', 1, 'user-1', 1]);
  });

  it('deactivates by status and author, and changes nothing else', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.deactivate(tx, 'doc-1', 'admin-1');
    expect(queries[0]!.sql).toMatch(
      /^update "documents" set "status" = \$1, "updated_by" = \$2 where "id" = \$3$/,
    );
    expect(queries[0]!.parameters).toEqual([0, 'admin-1', 'doc-1']);
  });
});
