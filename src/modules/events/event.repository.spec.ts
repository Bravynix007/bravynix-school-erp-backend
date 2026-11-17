import { sqlRecorder } from '../../../test/support/sql-recorder.js';
import { EventRepository } from './event.repository.js';

const repository = new EventRepository();
const filter = { from: '2026-12-01', to: '2026-12-31', holidaysOnly: false, audiences: [1, 3] };

describe('EventRepository', () => {
  it('lists the active events with a day in the span, for the audiences, earliest first', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.list(tx, filter);
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain(
      '"status" = $1 and "start_date" <= $2 and "end_date" >= $3 and "audience" in ($4, $5)',
    );
    expect(sql).not.toContain('is_holiday');
    expect(sql).toMatch(/order by "start_date", "end_date", lower\(title\), "id"$/);
    expect(parameters).toEqual([1, '2026-12-31', '2026-12-01', 1, 3]);
  });

  it('keeps holidays only when asked', async () => {
    const { tx, queries } = sqlRecorder();
    await repository.list(tx, { ...filter, holidaysOnly: true });
    expect(queries[0]!.sql).toContain('"is_holiday" = $6');
  });

  it('asks nothing of the database for a role that is told about no audience', async () => {
    const { tx, queries } = sqlRecorder();
    expect(await repository.list(tx, { ...filter, audiences: [] })).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('finds an event by its own row, locking only when it is about to change', async () => {
    const plain = sqlRecorder();
    expect(await repository.find(plain.tx, 'event-1')).toBeUndefined();
    expect(plain.queries[0]!.sql).not.toContain('for update');
    const locked = sqlRecorder();
    await repository.find(locked.tx, 'event-1', true);
    expect(locked.queries[0]!.sql).toMatch(/where "id" = \$1 for update$/);
  });

  it('inserts and updates one event and returns it', async () => {
    const insert = sqlRecorder();
    await expect(
      repository.insert(insert.tx, {
        society_id: 's',
        scope: 1,
        title: 't',
        start_date: '2026-12-01',
        end_date: '2026-12-01',
        duration_label: '1 Day',
      }),
    ).rejects.toThrow('no result');
    expect(insert.queries[0]!.sql).toMatch(/^insert into "events".* returning \*$/);
    const update = sqlRecorder();
    await expect(repository.update(update.tx, 'event-1', { title: 'x' })).rejects.toThrow(
      'no result',
    );
    expect(update.queries[0]!.sql).toMatch(
      /^update "events" set "title" = \$1 where "id" = \$2 returning \*$/,
    );
  });

  it('reads the classes of many holidays in one query, by event, and none for no event', async () => {
    const none = sqlRecorder();
    expect((await repository.classesOf(none.tx, [])).size).toBe(0);
    expect(none.queries).toEqual([]);
    const { tx, queries } = sqlRecorder();
    await repository.classesOf(tx, ['a', 'b']);
    expect(queries[0]!.sql).toContain('"event_id" in ($1, $2)');
    expect(queries[0]!.sql).toContain('order by "predefined_class_id"');
  });

  it('replaces the classes by deleting the set and writing the new one, and writes nothing for an empty set', async () => {
    const empty = sqlRecorder();
    await repository.replaceClasses(empty.tx, 'event-1', 'society-1', []);
    expect(empty.queries.map((q) => q.sql)).toEqual([
      'delete from "event_holiday_classes" where "event_id" = $1',
    ]);
    const some = sqlRecorder();
    await repository.replaceClasses(some.tx, 'event-1', 'society-1', ['c1', 'c2']);
    expect(some.queries).toHaveLength(2);
    expect(some.queries[1]!.sql).toMatch(/^insert into "event_holiday_classes"/);
    expect(some.queries[1]!.parameters).toEqual([
      'event-1',
      'c1',
      'society-1',
      'event-1',
      'c2',
      'society-1',
    ]);
  });
});
