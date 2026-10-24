/**
 * The media type of a Content-Type header, lower case and without parameters,
 * e.g. `application/json`; empty when the header is missing (API design 7.2).
 * The charset is body-parser's to read: it decodes the body with it.
 */
export function mediaTypeOf(header: string | undefined): string {
  return (header ?? '').split(';', 1)[0]!.trim().toLowerCase();
}
