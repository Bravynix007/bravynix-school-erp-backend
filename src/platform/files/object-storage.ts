/** A one-use permission to send one object (API design 15.1 step 2). */
export interface UploadTicket {
  url: string;
  /** Form fields to send before the file. */
  fields: Record<string, string>;
  expiresAt: Date;
}

/** A short-lived link that downloads one object (API design 15.3). */
export interface DownloadTicket {
  url: string;
  expiresAt: Date;
}

/**
 * Where file content lives. Files never pass through the API (SDD 10.7): the client sends them to the address of
 * an upload ticket. Only the local driver exists now, for development, tests and the demo; the S3 driver (presigned
 * POST and GET) is a separate slice with the deployment (decision of 8 Nov 2026).
 */
export abstract class ObjectStorage {
  /** A ticket that accepts one object under `key`, of this type and at most `maxBytes`, until `expiresAt`. */
  abstract createUpload(input: {
    key: string;
    contentType: string;
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
}
