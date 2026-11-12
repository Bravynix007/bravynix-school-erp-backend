import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { ClassRepository } from './class.repository.js';

describe('ClassRepository.isLast', () => {
  it('compares the class with the active classes of its Institution in the order of the predefined classes', async () => {
    const { tx, queries } = sqlRecorder();
    expect(await new ClassRepository().isLast(tx, 'class-1')).toBeUndefined();
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain(
      'inner join "predefined_classes" as "p" on "p"."id" = "c"."predefined_class_id"',
    );
    expect(sql).toContain('not exists');
    expect(sql).toContain('"later"."institution_id" = "c"."institution_id"');
    expect(sql).toContain('"later"."status" = $1');
    expect(sql).toContain('"q"."display_order" > "p"."display_order"');
    expect(sql).toContain('"c"."id" = $2');
    expect(parameters).toEqual([1, 'class-1']);
  });
});
