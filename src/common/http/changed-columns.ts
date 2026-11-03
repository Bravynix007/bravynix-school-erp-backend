/**
 * The columns of `wanted` whose value differs from the stored row: what a PATCH really changes. An omitted field
 * (`undefined`) is left alone, `null` is a value; nothing changed means nothing is written (API design 14).
 */
export function changedColumns<Row extends object>(
  current: Row,
  wanted: Partial<Record<keyof Row, unknown>>,
): Partial<Row> {
  return Object.fromEntries(
    Object.entries(wanted).filter(
      ([column, value]) => value !== undefined && current[column as keyof Row] !== value,
    ),
  ) as Partial<Row>;
}
