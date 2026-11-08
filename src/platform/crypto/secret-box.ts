import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for secrets kept at rest (DDD 15.6): the authenticator secret
 * of a Super Admin and the Aadhaar numbers of staff and students. The stored
 * value is `iv | tag | ciphertext`; the tag makes any change to it fail on
 * opening, and `context` (table, column and row) is authenticated with it, so
 * a value copied to another row or column does not open. `keyVersion` is
 * stored beside the value so a key can be rotated later.
 */
export class SecretBox {
  readonly keyVersion = 1;
  private readonly key: Buffer;

  /**
   * @param base64Key 32 bytes, base64; a fresh key when absent. Only for values that may be lost
   *   with the process (authenticator secrets in development); stored data must pass its key.
   * @param keyName the setting the key comes from, for the error message.
   */
  constructor(base64Key: string | undefined, keyName: string) {
    this.key = base64Key ? Buffer.from(base64Key, 'base64') : randomBytes(32);
    if (this.key.length !== 32) {
      throw new Error(`${keyName} must be 32 bytes, base64 encoded`);
    }
  }

  seal(plain: Buffer, context: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  /** Throws when the value was changed, is too short, or belongs to another context or key. */
  open(sealed: Buffer, context: string): Buffer {
    if (sealed.length <= IV_BYTES + TAG_BYTES) throw new Error('Sealed value is too short');
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  }
}
