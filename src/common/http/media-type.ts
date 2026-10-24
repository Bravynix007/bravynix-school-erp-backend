/** The parts of a Content-Type header this API looks at (API design 7.2). */
export interface MediaType {
  /** Lower case, e.g. `application/json`; empty when the header is missing. */
  mime: string;
  /** Lower case and unquoted (RFC 9110 allows `charset="utf-8"`). */
  charset?: string;
}

export function parseMediaType(header: string | undefined): MediaType {
  const [mime = '', ...params] = (header ?? '')
    .toLowerCase()
    .split(';')
    .map((part) => part.trim());
  const charset = params
    .find((param) => param.startsWith('charset='))
    ?.slice('charset='.length)
    .replace(/^"(.*)"$/, '$1');
  return charset === undefined ? { mime } : { mime, charset };
}

/** Whether the header names JSON in a charset other than UTF-8. */
export function isNonUtf8Json({ mime, charset }: MediaType): boolean {
  return mime === 'application/json' && charset !== undefined && charset !== 'utf-8';
}
