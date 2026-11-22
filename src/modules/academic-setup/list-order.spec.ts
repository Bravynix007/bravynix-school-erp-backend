import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { orderClasses, orderSections } from './list-order.js';

const db = new Kysely<Record<string, Record<string, unknown>>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('the order of the lists', () => {
  it('lists classes by category, predefined class, stream with none first, then ID, under the aliases it is given', () => {
    const { sql } = db
      .selectFrom('classes as c')
      .select('c.id')
      .$call(orderClasses('g', 'pc', 'c'))
      .compile();
    expect(sql).toContain(
      'order by "g"."display_order", "pc"."display_order", lower("c"."stream_name") asc nulls first, "c"."id"',
    );
  });

  it('lists sections by predefined section, then ID', () => {
    const { sql } = db
      .selectFrom('sections as s')
      .select('s.id')
      .$call(orderSections('ps', 's'))
      .compile();
    expect(sql).toContain('order by "ps"."display_order", "s"."id"');
  });
});
