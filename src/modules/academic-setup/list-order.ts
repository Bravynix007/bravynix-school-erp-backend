import { sql, type SelectQueryBuilder } from 'kysely';

/**
 * The order classes are listed in everywhere: category, predefined class, then stream (a class with none first), then
 * its ID so that two of the same name never swap. Takes the aliases of the category (`g`), the predefined class (`p`)
 * and the class (`c`) of the query: `query.$call(orderClasses('g', 'p', 'c'))`.
 */
export function orderClasses(category: string, predefined: string, klass: string) {
  return <DB, TB extends keyof DB, O>(query: SelectQueryBuilder<DB, TB, O>) =>
    query
      .orderBy(sql.ref(`${category}.display_order`))
      .orderBy(sql.ref(`${predefined}.display_order`))
      .orderBy(sql`lower(${sql.ref(`${klass}.stream_name`)})`, (order) => order.asc().nullsFirst())
      .orderBy(sql.ref(`${klass}.id`));
}

/**
 * The order the sections of a class are listed in: the order of the predefined sections, then the section's ID.
 * Takes the aliases of the predefined section (`p`) and of the section (`s`).
 */
export function orderSections(predefined: string, section: string) {
  return <DB, TB extends keyof DB, O>(query: SelectQueryBuilder<DB, TB, O>) =>
    query.orderBy(sql.ref(`${predefined}.display_order`)).orderBy(sql.ref(`${section}.id`));
}
