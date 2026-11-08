import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Clock } from '../../common/time/clock.js';
import { ObjectStorage, type DownloadTicket, type UploadTicket } from './object-storage.js';

/** What a signed address permits. */
export interface LocalGrant {
  op: 'put' | 'get';
  key: string;
  contentType: string;
  /** Upload only: the most bytes accepted. */
  maxBytes: number;
  /** Download only: the name offered to the browser. */
  fileName: string | null;
  /** Epoch milliseconds. */
  expires: number;
}

/** The path the signed addresses live under, served by `localStorageMiddleware`. */
export const LOCAL_STORAGE_PATH = '/local-storage';

/**
 * Files on the server's own disk, for development, tests and the demo. It keeps the shape of the real store: an
 * upload ticket is an address that accepts one object of one type and size until it expires, and a download link
 * is an address that serves one object as an attachment. The addresses are signed with a key made at start, so
 * they stop working when the process restarts, like a presigned link that expires.
 */
export class LocalObjectStorage extends ObjectStorage {
  constructor(
    private readonly directory: string,
    private readonly baseUrl: string,
    private readonly secret: Buffer,
    private readonly clock: Clock,
  ) {
    super();
  }

  createUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresAt: Date;
  }): Promise<UploadTicket> {
    const token = this.sign({
      op: 'put',
      key: input.key,
      contentType: input.contentType,
      maxBytes: input.maxBytes,
      fileName: null,
      expires: input.expiresAt.getTime(),
    });
    return Promise.resolve({ url: this.addressOf(token), fields: {}, expiresAt: input.expiresAt });
  }

  createDownload(input: {
    key: string;
    contentType: string;
    fileName: string | null;
    expiresAt: Date;
  }): Promise<DownloadTicket> {
    const token = this.sign({
      op: 'get',
      key: input.key,
      contentType: input.contentType,
      maxBytes: 0,
      fileName: input.fileName,
      expires: input.expiresAt.getTime(),
    });
    return Promise.resolve({ url: this.addressOf(token), expiresAt: input.expiresAt });
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  /**
   * Stores the bytes of an accepted upload, unless an object is already there: an address sends one object once,
   * so a file that was sent, and perhaps confirmed, is never replaced. False when it was already there.
   */
  async write(key: string, bytes: Buffer): Promise<boolean> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, bytes, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  /** The grant a signed address carries, or null when it is forged, malformed or expired. */
  verify(token: string): LocalGrant | null {
    const [payload, signature, ...rest] = token.split('.');
    if (!payload || !signature || rest.length > 0) return null;
    const expected = this.signature(payload);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LocalGrant;
      return grant.expires > this.clock.now().getTime() ? grant : null;
    } catch {
      return null;
    }
  }

  private sign(grant: LocalGrant): string {
    const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
    return `${payload}.${this.signature(payload).toString('base64url')}`;
  }

  private signature(payload: string): Buffer {
    return createHmac('sha256', this.secret).update(payload).digest();
  }

  private addressOf(token: string): string {
    return `${this.baseUrl}/v1${LOCAL_STORAGE_PATH}/${token}`;
  }

  /** Keys are made by the server, but a path that leaves the directory is refused all the same. */
  private pathOf(key: string): string {
    const root = resolve(this.directory);
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new Error('Object key outside the storage directory');
    return path;
  }
}
