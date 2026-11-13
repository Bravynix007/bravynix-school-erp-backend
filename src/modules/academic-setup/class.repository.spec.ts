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

describe('ClassRepository.orders', () => {
  it('reads the place of the classes in the order of the predefined classes, with their Institution', async () => {
    const { tx, queries } = sqlRecorder();
    expect(await new ClassRepository().orders(tx, ['class-1', 'class-2'])).toEqual(new Map());
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain(
      'inner join "predefined_classes" as "p" on "p"."id" = "c"."predefined_class_id"',
    );
    expect(sql).toContain('"p"."display_order"');
    expect(sql).toContain('"c"."id" in ($1, $2)');
    expect(parameters).toEqual(['class-1', 'class-2']);
  });
});
