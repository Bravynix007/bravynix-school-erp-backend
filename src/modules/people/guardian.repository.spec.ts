import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { GuardianRepository } from './guardian.repository.js';

const repository = new GuardianRepository();

describe('GuardianRepository', () => {
  it('finds a guardian, active or not, and locks the row only when asked', async () => {
    const plain = sqlRecorder();
    await repository.find(plain.tx, 'guardian-1');
    expect(plain.queries[0]!.sql).toContain('from "student_guardians" where "id" = $1');
    expect(plain.queries[0]!.sql).not.toContain('for update');
    expect(plain.queries[0]!.parameters).toEqual(['guardian-1']);
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'guardian-1', true);
    expect(locked.queries[0]!.sql).toMatch(/for update$/);
  });

  it('updates one guardian and returns the row', async () => {
    const { tx, queries } = sqlRecorder();
    await expect(repository.update(tx, 'guardian-1', { status: 0 })).rejects.toThrow('no result');
    expect(queries[0]!.sql).toMatch(
      /^update "student_guardians" set "status" = \$1 where "id" = \$2 returning \*/,
    );
  });

  it('finds the active primary of a student', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.primaryOf(tx, 'student-1');
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"student_id" = $1');
    expect(sql).toContain('"is_primary" = $2');
    expect(sql).toContain('"status" = $3');
    expect(parameters).toEqual(['student-1', true, 1]);
  });

  it('asks whether a person is an active guardian of the student, leaving one guardian out when told to', async () => {
    const all = sqlRecorder();
    expect(await repository.isLinked(all.tx, 'student-1', 'user-1')).toBe(false);
    expect(all.queries[0]!.sql).toContain('"user_id" = $2');
    expect(all.queries[0]!.sql).not.toContain('<>');
    const except = sqlRecorder();
    await repository.isLinked(except.tx, 'student-1', 'user-1', 'guardian-1');
    expect(except.queries[0]!.sql).toContain('"id" <> $4');
    expect(except.queries[0]!.parameters).toEqual(['student-1', 'user-1', 1, 'guardian-1']);
  });
});
