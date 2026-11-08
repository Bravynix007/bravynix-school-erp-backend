const startsWith = (bytes: Buffer, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether the bytes of an upload are what its declared type says (API design 15.4: the first bytes must match).
 * A CSV has no signature, so it must be valid UTF-8 without NUL characters.
 */
export function matchesDeclaredType(bytes: Buffer, contentType: string): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case 'application/pdf':
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'text/csv':
      if (bytes.includes(0)) return false;
      try {
        utf8.decode(bytes);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}
