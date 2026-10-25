import { randomUUID } from 'node:crypto';
import {
  changedFields,
  MAX_AUDIT_VALUES_BYTES,
  redactValues,
  serializeValues,
} from './audit-values.js';

describe('changedFields', () => {
  it('keeps only the fields that changed, old beside new', () => {
    const result = changedFields(
      { firstName: 'Asha', lastName: 'Rao', rollNumber: 7 },
      { firstName: 'Asha', lastName: 'Rai', rollNumber: 8 },
    );
    expect(result).toEqual({
      old: { lastName: 'Rao', rollNumber: 7 },
      new: { lastName: 'Rai', rollNumber: 8 },
    });
  });

  it('records every field of a create as new, and of a delete as old', () => {
    expect(changedFields(null, { name: 'Sunrise' })).toEqual({
      old: null,
      new: { name: 'Sunrise' },
    });
    expect(changedFields({ name: 'Sunrise' }, undefined)).toEqual({
      old: { name: 'Sunrise' },
      new: null,
    });
    expect(changedFields(null, null)).toEqual({ old: null, new: null });
  });

  it('shows a field that was added or cleared', () => {
    expect(changedFields({ a: 1 }, { a: 1, b: 2 })).toEqual({ old: {}, new: { b: 2 } });
    expect(changedFields({ a: 1, b: 2 }, { a: 1 })).toEqual({ old: { b: 2 }, new: {} });
  });

  it('ignores the order of keys inside a nested value (m6)', () => {
    const result = changedFields(
      { address: { city: 'Mysuru', pin: '570001' } },
      { address: { pin: '570001', city: 'Mysuru' } },
    );
    expect(result).toEqual({ old: {}, new: {} });
  });

  it('compares nested values by content', () => {
    const same = changedFields({ address: { city: 'Mysuru' } }, { address: { city: 'Mysuru' } });
    expect(same).toEqual({ old: {}, new: {} });
  });
});

describe('redactValues', () => {
  it('never records codes, tokens, hashes, passwords or keys', () => {
    const result = redactValues({
      name: 'Asha',
      otp: '123456',
      otpCode: '123456',
      refresh_token: 'rt_x',
      refreshTokenHash: 'abc',
      mfa_secret: 'JBSWY3DP',
      password: 'x',
      codeHash: 'abc',
      apiKey: 'k',
      totp_secret_ciphertext: 'zz',
    });
    expect(result).toEqual({ name: 'Asha' });
  });

  it('drops secrets under every common spelling, including acronyms and plurals (S1)', () => {
    const secrets = [
      'OTPCode',
      'TOTPSecret',
      'APIKey',
      'JWT',
      'jwt',
      'pwd',
      'passwd',
      'mpin',
      'pinHash',
      'tokens',
      'passwords',
      'recoveryCodes',
      'backup_codes',
      'refreshTokens',
      'cvv',
      'salt',
      'cookie',
      'Authorization',
      'credentials',
      'privateKey',
      'accessKey',
      'secrets',
      'hashes',
    ];
    const result = redactValues({
      keep: 'yes',
      ...Object.fromEntries(secrets.map((k) => [k, 'x'])),
    });
    expect(result).toEqual({ keep: 'yes' });
  });

  it('masks Aadhaar and bank numbers under every common spelling (S1)', () => {
    const names = [
      'aadhaarNo',
      'aadhaar_no',
      'aadhar_number',
      'aadharNo',
      'aadhaarNumber',
      'aadhaar_id',
      'bankAccountNo',
      'bank_account_no',
      'account_number',
      'accountNumber',
      'acct_no',
      'account',
      'studentAadhaar',
      'guardian_aadhaar_number',
    ];
    const result = redactValues(Object.fromEntries(names.map((k) => [k, '1234 5678 9012'])));
    for (const name of names) expect(result[name]).toEqual({ changed: true, last4: '9012' });
    // Also inside a nested object.
    expect(redactValues({ student: { aadhar_number: '123456789012' } })).toEqual({
      student: { aadhar_number: { changed: true, last4: '9012' } },
    });
  });

  it('keeps names that only share a word with a secret or an ID number', () => {
    const kept = {
      tokens_used: 1,
      account_holder_name: 'Asha',
      bank_name: 'SBI',
      ifsc: 'SBIN0000001',
      pin_code: '570001',
      uid: 'u1',
    };
    expect(redactValues(kept)).toEqual(kept);
  });

  it('masks an Aadhaar-shaped number in any text, whatever the key (S1)', () => {
    expect(
      redactValues({
        note: 'Aadhaar 1234 5678 9012 given',
        remarks: ['seen 123456789012', 'ref 1234-5678-9012.'],
        nested: { text: 'no. 9999 8888 7777' },
      }),
    ).toEqual({
      note: 'Aadhaar XXXX XXXX 9012 given',
      remarks: ['seen XXXX XXXX 9012', 'ref XXXX XXXX 9012.'],
      nested: { text: 'no. XXXX XXXX 7777' },
    });
  });

  it('leaves a UUID alone even when its last group is 12 digits (N1)', () => {
    const id = '0192f6b0-11aa-7c3d-9b4f-123456789012';
    expect(redactValues({ sectionId: id, nested: { ids: [id] }, note: `section ${id}.` })).toEqual({
      sectionId: id,
      nested: { ids: [id] },
      note: `section ${id}.`,
    });
  });

  it('leaves randomly generated UUIDs unchanged (N1)', () => {
    for (let i = 0; i < 20_000; i += 1) {
      const id = randomUUID();
      expect(redactValues({ id }).id).toBe(id);
    }
  });

  it('still masks an Aadhaar number set off by punctuation (N1)', () => {
    expect(
      redactValues({
        a: '(1234 5678 9012).',
        b: 'ID:123456789012',
        c: '1234-5678-9012',
        d: '123456789012',
      }),
    ).toEqual({
      a: '(XXXX XXXX 9012).',
      b: 'ID:XXXX XXXX 9012',
      c: 'XXXX XXXX 9012',
      d: 'XXXX XXXX 9012',
    });
  });

  it('leaves short numbers and ordinary text alone', () => {
    const kept = { phone: '9999999999', roll: '12345', year: '2026-2027', note: 'Class 7A' };
    expect(redactValues(kept)).toEqual(kept);
  });

  it('keeps fields that only look similar', () => {
    const result = redactValues({
      tokens_used: 120,
      object_key: 'a/b/c',
      class_code: '7A',
      idempotency_key: 'k1',
    });
    expect(result).toEqual({
      tokens_used: 120,
      object_key: 'a/b/c',
      class_code: '7A',
      idempotency_key: 'k1',
    });
  });

  it('shows an Aadhaar or bank number only as changed, with the last 4 digits', () => {
    const result = redactValues({
      aadhaar: '1234 5678 9012',
      aadhaarNumber: '123456789012',
      bank_account: '000123456789',
      bankAccountNumber: 12,
    });
    expect(result).toEqual({
      aadhaar: { changed: true, last4: '9012' },
      aadhaarNumber: { changed: true, last4: '9012' },
      bank_account: { changed: true, last4: '6789' },
      bankAccountNumber: { changed: true, last4: null },
    });
  });

  it('leaves a ready-made last-4 field alone', () => {
    expect(redactValues({ aadhaar_last4: '9012' })).toEqual({ aadhaar_last4: '9012' });
  });

  it('cleans nested objects and arrays', () => {
    const result = redactValues({
      contact: { phone: '99999 99999', token: 'x' },
      devices: [{ label: 'Pixel', pushToken: 'y' }],
    });
    expect(result).toEqual({
      contact: { phone: '99999 99999' },
      devices: [{ label: 'Pixel' }],
    });
  });

  it('applies to a diff, so a secret never survives in old or new', () => {
    const result = changedFields({ email: 'a@x.test', otp: '1' }, { email: 'b@x.test', otp: '2' });
    expect(result).toEqual({ old: { email: 'a@x.test' }, new: { email: 'b@x.test' } });
  });
});

describe('serializeValues', () => {
  it('passes null through and writes JSON text', () => {
    expect(serializeValues(null)).toBeNull();
    expect(serializeValues({ a: 1 })).toBe('{"a":1}');
  });

  it('refuses a value that is too large', () => {
    expect(() => serializeValues({ blob: 'x'.repeat(MAX_AUDIT_VALUES_BYTES) })).toThrow(/over/);
  });
});
