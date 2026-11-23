import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { DiaryRepository } from './diary.repository.js';

describe('DiaryRepository', () => {
  const repository = new DiaryRepository();

  it('lists the active entries of a section on a date in the order they were written', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.list(tx, 'section-1', '2026-11-17');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('from "diary_entries"');
    expect(sql).toContain('"section_id" = $1 and "diary_date" = $2 and "status" = $3');
    expect(sql).toContain('order by "created_at", "id"');
    expect(parameters).toEqual(['section-1', '2026-11-17', 1]);
  });

  it('finds one entry, locked when it is about to change', async () => {
    const plain = sqlRecorder();
    await repository.find(plain.tx, 'entry-1');
    expect(plain.queries[0]!.sql).not.toContain('for update');
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'entry-1', true);
    expect(locked.queries[0]!.sql).toMatch(/where "id" = \$1 for update$/);
  });

  it('inserts and updates one entry and returns it', async () => {
    const insert = sqlRecorder();
    await expect(
      repository.insert(insert.tx, {
        society_id: 's',
        institution_id: 'i',
        academic_year_id: 'y',
        section_id: 'sec',
        subject_id: 'sub',
        staff_member_id: null,
        diary_date: '2026-11-17',
        description: 'd',
      }),
    ).rejects.toThrow('no result');
    expect(insert.queries[0]!.sql).toMatch(/^insert into "diary_entries".* returning \*$/);
    const update = sqlRecorder();
    await expect(repository.update(update.tx, 'entry-1', { description: 'x' })).rejects.toThrow(
      'no result',
    );
    expect(update.queries[0]!.sql).toMatch(
      /^update "diary_entries" set "description" = \$1 where "id" = \$2 returning \*$/,
    );
  });
});
