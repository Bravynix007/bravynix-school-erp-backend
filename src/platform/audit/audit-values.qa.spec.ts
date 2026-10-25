// QA for Phase 1 B1: the redaction safety net against key names real callers use.
import { redactValues } from './audit-values.js';

const SECRETS = [
  'APIKey',
  'apikey',
  'otp1',
  'pin',
  'mpin',
  'pwd',
  'passwd',
  'authorization',
  'cookie',
  'jwt',
  'refreshTokens',
  'secrets',
  'backupCodes',
  'recoveryCodes',
  'credentials',
];
const ID_NUMBERS = ['aadhaarNo', 'aadhar', 'aadharNumber', 'accountNumber', 'bankAccountNo'];

describe('QA: redaction catches common spellings', () => {
  it('drops every secret-looking key', () => {
    const leaked = SECRETS.filter((key) => key in redactValues({ [key]: 'x-sensitive-123456' }));
    expect(leaked).toEqual([]);
  });

  it('masks every ID-number-looking key to the last 4 digits', () => {
    const clear = ID_NUMBERS.filter(
      (key) => redactValues({ [key]: '1234 5678 9012' })[key] === '1234 5678 9012',
    );
    expect(clear).toEqual([]);
  });

  it('keeps ordinary fields where "pin" or "token" is only part of a word', () => {
    expect(redactValues({ pincode: '600001', spinner: true, tokenised: 'x' })).toEqual({
      pincode: '600001',
      spinner: true,
      tokenised: 'x',
    });
  });
});
