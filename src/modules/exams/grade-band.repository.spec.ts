import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { GradeBandRepository } from './grade-band.repository.js';

const repository = new GradeBandRepository();

describe('GradeBandRepository', () => {
  it('lists the active bands of an Institution, the highest first', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.active(tx, 'inst-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"institution_id" = $1 and "status" = $2');
    expect(sql).toMatch(/order by "min_percentage" desc$/);
    expect(parameters).toEqual(['inst-1', 1]);
  });

  it('finds a band by its own row, locking only when it is about to change', async () => {
    const plain = sqlRecorder();
    await repository.find(plain.tx, 'band-1');
    expect(plain.queries[0]!.sql).not.toContain('for update');
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'band-1', true);
    expect(locked.queries[0]!.sql).toMatch(/where "id" = \$1 for update$/);
  });
});
