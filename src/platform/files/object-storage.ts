/** A one-use permission to send one object (API design 15.1 step 2). */
export interface UploadTicket {
  url: string;
  /** `POST` takes a multipart form (local disk); `PUT` takes the file as the whole body (R2, which has no POST policy). */
  method: 'POST' | 'PUT';
  /** Form fields to send before the file (POST). */
  fields: Record<string, string>;
  /** Headers the send must carry, because the address is signed for them (PUT). */
  headers: Record<string, string>;
  expiresAt: Date;
}

/** Objects of the public bucket have keys that begin with this; every other key is in the private bucket (DDD 16.1). */
export const PUBLIC_KEY_PREFIX = 'public/';

export const isPublicKey = (key: string): boolean => key.startsWith(PUBLIC_KEY_PREFIX);

/** A short-lived link that downloads one object (API design 15.3). */
export interface DownloadTicket {
  url: string;
  /** Null for a public file: its address does not expire. */
  expiresAt: Date | null;
}

/**
 * Where file content lives. Files never pass through the API (SDD 10.7): the client sends them to the address of
 * an upload ticket. The local driver is for development, tests and the demo; the R2 driver (presigned PUT and GET) is
 * the production store (decision of 8 Nov 2026). A key that begins with [PUBLIC_KEY_PREFIX] is in the public bucket,
 * which anyone can read at `publicUrl`; every other key is private and is read only through a download link.
 */
export abstract class ObjectStorage {
  /** A ticket that accepts one object under `key`, of this type and at most `maxBytes`, until `expiresAt`. */
  abstract createUpload(input: {
    key: string;
    contentType: string;
    /** The size the client declared: a store that can sign it accepts no other. */
    sizeBytes: number;
    maxBytes: number;
    expiresAt: Date;
  }): Promise<UploadTicket>;

  /** The whole object (at most 5 MB), or null when nothing was uploaded under `key`. */
  abstract read(key: string): Promise<Buffer | null>;

  /** A link that downloads the object as an attachment of a fixed type, so a browser never runs it. */
  abstract createDownload(input: {
    key: string;
    contentType: string;
    fileName: string | null;
    expiresAt: Date;
  }): Promise<DownloadTicket>;

  /** Removes the object; removing one that is not there is not an error. */
  abstract remove(key: string): Promise<void>;

  /** The address anyone can read a public object at (key begins with [PUBLIC_KEY_PREFIX]). */
  abstract publicUrl(key: string): string;
}
