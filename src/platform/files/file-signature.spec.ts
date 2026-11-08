import { matchesDeclaredType } from './file-signature.js';

const bytes = (...values: number[]) => Buffer.from(values);
const ascii = (text: string) => Buffer.from(text, 'latin1');

describe('matchesDeclaredType', () => {
  it('knows a JPEG, a PNG, a WebP and a PDF by their first bytes', () => {
    expect(matchesDeclaredType(bytes(0xff, 0xd8, 0xff, 0xe0, 0), 'image/jpeg')).toBe(true);
    expect(
      matchesDeclaredType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), 'image/png'),
    ).toBe(true);
    expect(
      matchesDeclaredType(
        Buffer.concat([ascii('RIFF'), bytes(1, 2, 3, 4), ascii('WEBPVP8 ')]),
        'image/webp',
      ),
    ).toBe(true);
    expect(matchesDeclaredType(ascii('%PDF-1.7\n'), 'application/pdf')).toBe(true);
  });

  it('refuses bytes that are another type than declared', () => {
    expect(matchesDeclaredType(ascii('%PDF-1.7\n'), 'image/jpeg')).toBe(false);
    expect(matchesDeclaredType(bytes(0xff, 0xd8, 0xff), 'application/pdf')).toBe(false);
    expect(matchesDeclaredType(ascii('RIFF....WAVEfmt '), 'image/webp')).toBe(false);
    expect(matchesDeclaredType(bytes(0x89, 0x50, 0x4e, 0x47), 'image/png')).toBe(false);
    expect(matchesDeclaredType(Buffer.alloc(0), 'image/jpeg')).toBe(false);
  });

  it('takes a CSV that is UTF-8 text, and refuses a NUL byte, invalid UTF-8 and a binary file', () => {
    expect(
      matchesDeclaredType(Buffer.from('Name,RollNumber\nAsha ಅ,1\n', 'utf8'), 'text/csv'),
    ).toBe(true);
    expect(matchesDeclaredType(Buffer.alloc(0), 'text/csv')).toBe(true);
    expect(matchesDeclaredType(bytes(0x41, 0x00, 0x42), 'text/csv')).toBe(false);
    expect(matchesDeclaredType(bytes(0xc3, 0x28), 'text/csv')).toBe(false);
    expect(matchesDeclaredType(ascii('%PDF-1.7\n\0'), 'text/csv')).toBe(false);
  });

  it('refuses a type nobody declared', () => {
    expect(matchesDeclaredType(ascii('<script>'), 'text/html')).toBe(false);
  });
});
