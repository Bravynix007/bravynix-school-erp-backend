import { base32Encode, matchTotp, setupUri, stepAt, totpAt } from './totp.js';

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890". The RFC lists
// 8-digit codes; the 6-digit code is their last six digits.
const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
const rfc: [seconds: number, code: string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('totpAt', () => {
  it.each(rfc)('matches the RFC 6238 vector at %i seconds', (seconds, code) => {
    expect(totpAt(rfcSecret, stepAt(new Date(seconds * 1000)))).toBe(code);
  });
});

describe('base32Encode', () => {
  it('matches the RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32Encode(rfcSecret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('matchTotp', () => {
  const now = new Date(1234567890 * 1000);
  const step = stepAt(now);

  it('accepts the current code and returns its step', () => {
    expect(matchTotp(rfcSecret, '005924', now, null)).toBe(step);
  });

  it('accepts a neighbouring step for a phone clock a little off, and not two away', () => {
    expect(matchTotp(rfcSecret, totpAt(rfcSecret, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(rfcSecret, totpAt(rfcSecret, step + 1), now, null)).toBe(step + 1);
    expect(matchTotp(rfcSecret, totpAt(rfcSecret, step - 2), now, null)).toBeNull();
    expect(matchTotp(rfcSecret, totpAt(rfcSecret, step + 2), now, null)).toBeNull();
  });

  it('never accepts a step that was used, or an older one', () => {
    expect(matchTotp(rfcSecret, totpAt(rfcSecret, step), now, step)).toBeNull();
    expect(matchTotp(rfcSecret, totpAt(rfcSecret, step - 1), now, step)).toBeNull();
    expect(matchTotp(rfcSecret, totpAt(rfcSecret, step + 1), now, step)).toBe(step + 1);
  });

  it.each(['', '12345', '1234567', 'abcdef', '005 924', '０05924'])('refuses %j', (submitted) => {
    expect(matchTotp(rfcSecret, submitted, now, null)).toBeNull();
  });
});

describe('setupUri', () => {
  it('builds the link an authenticator app reads', () => {
    const uri = setupUri(rfcSecret, 'BravyNix School ERP', 'asha@example.test');
    expect(uri).toBe(
      'otpauth://totp/BravyNix%20School%20ERP:asha%40example.test' +
        '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=BravyNix+School+ERP' +
        '&algorithm=SHA1&digits=6&period=30',
    );
  });
});
